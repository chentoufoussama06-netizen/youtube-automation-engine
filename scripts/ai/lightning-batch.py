"""
Run a batch of LLM prompts on a free Lightning AI GPU, then switch it off.

    C:\\lt\\Scripts\\python.exe scripts/ai/lightning-batch.py prompts.jsonl results.jsonl
    C:\\lt\\Scripts\\python.exe scripts/ai/lightning-batch.py prompts.jsonl results.jsonl --machine T4

Input, one JSON object per line:
    {"id": "doc-foe", "system": "You write...", "prompt": "Write...", "max_tokens": 900}
Output, one per line:
    {"id": "doc-foe", "text": "..."}

Why batch and not a server: the free account's only always-on Studio is
CPU. GPU time comes out of a monthly allowance, and a GPU Studio left idle
spends it. So this borrows the GPU for exactly as long as the batch takes
— switch the Studio up, generate everything in one vLLM pass, switch back
to CPU in a `finally`, even when generation fails.

Runs from the short-path venv at C:\\lt because lightning-sdk's install
paths exceed Windows' 260-character limit anywhere deeper.

Credentials come from this repo's .env (LIGHTNING_USER_ID, LIGHTNING_API_KEY,
LIGHTNING_USERNAME). Model override: LIGHTNING_MODEL.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Qwen3-14B quantized fits an L4 (24 GB) with room for a long context. It is a
# solid judge and a decent drafter; for final scripts the hosted GLM-5.3 route
# in WHOP OS's lib/ai.ts still writes better.
DEFAULT_MODEL = "Qwen/Qwen3-14B-AWQ"

REMOTE_DIR = "batch"

# Runs inside the Studio. Kept as a string so the batch is one upload.
REMOTE_RUNNER = r'''
import json, sys
from vllm import LLM, SamplingParams

model, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
jobs = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
llm = LLM(model=model, max_model_len=8192, gpu_memory_utilization=0.9)
tok = llm.get_tokenizer()

prompts, params = [], []
for j in jobs:
    msgs = ([{"role": "system", "content": j["system"]}] if j.get("system") else []) + [{"role": "user", "content": j["prompt"]}]
    prompts.append(tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False))
    params.append(SamplingParams(temperature=j.get("temperature", 0.7), max_tokens=j.get("max_tokens", 900)))

outs = llm.generate(prompts, params)
with open(dst, "w", encoding="utf-8") as f:
    for j, o in zip(jobs, outs):
        f.write(json.dumps({"id": j["id"], "text": o.outputs[0].text.strip()}, ensure_ascii=False) + "\n")
print(f"generated {len(outs)}")
'''


def load_env():
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("LIGHTNING_") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    missing = [k for k in ("LIGHTNING_USER_ID", "LIGHTNING_API_KEY", "LIGHTNING_USERNAME") if not os.environ.get(k)]
    if missing:
        sys.exit(f"missing in .env: {', '.join(missing)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompts")
    ap.add_argument("results")
    ap.add_argument("--machine", default="L4", help="L4 (24 GB) or T4 (16 GB)")
    ap.add_argument("--studio", default="scratch-studio-devbox")
    ap.add_argument("--teamspace", default="default-project")
    args = ap.parse_args()

    load_env()
    from lightning_sdk import Machine, Studio

    jobs = [l for l in Path(args.prompts).read_text(encoding="utf-8").splitlines() if l.strip()]
    if not jobs:
        sys.exit("no prompts in input")
    model = os.environ.get("LIGHTNING_MODEL", DEFAULT_MODEL)

    studio = Studio(name=args.studio, teamspace=args.teamspace, user=os.environ["LIGHTNING_USERNAME"])
    print(f"{len(jobs)} prompt(s) -> {model} on {args.machine}")

    started = time.time()
    try:
        gpu = getattr(Machine, args.machine)
        studio.start(gpu) if str(studio.status) != "Running" else studio.switch_machine(gpu)

        runner = ROOT / "temp" / "lightning_runner.py"
        runner.parent.mkdir(exist_ok=True)
        runner.write_text(REMOTE_RUNNER, encoding="utf-8")
        studio.run(f"mkdir -p {REMOTE_DIR}")
        studio.upload_file(str(runner), f"{REMOTE_DIR}/runner.py")
        studio.upload_file(args.prompts, f"{REMOTE_DIR}/in.jsonl")

        # vLLM installs onto the Studio's persistent disk, so only the first
        # batch pays for it.
        studio.run("python -c 'import vllm' 2>/dev/null || pip install -q vllm")
        print(studio.run(f"cd {REMOTE_DIR} && python runner.py {model} in.jsonl out.jsonl 2>&1 | tail -n 3"))

        studio.download_file(f"{REMOTE_DIR}/out.jsonl", args.results)
        done = sum(1 for l in Path(args.results).read_text(encoding="utf-8").splitlines() if l.strip())
        print(f"{done}/{len(jobs)} result(s) -> {args.results}")
    finally:
        # Never leave the GPU running: that is the whole free allowance draining.
        try:
            studio.switch_machine(Machine.CPU)
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: could not switch back to CPU ({e}) — stop it at lightning.ai NOW")
        print(f"GPU time used: {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
