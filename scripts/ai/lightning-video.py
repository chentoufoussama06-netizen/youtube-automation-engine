"""
Generate AI video shots (with matching sound effects) on a Lightning GPU.

    C:\\lt\\Scripts\\python.exe scripts/ai/lightning-video.py start  shots.json
    C:\\lt\\Scripts\\python.exe scripts/ai/lightning-video.py status
    C:\\lt\\Scripts\\python.exe scripts/ai/lightning-video.py fetch  out_dir

shots.json:
    {"style": "...appended to every prompt...",
     "shots": [{"id": "s1", "prompt": "...", "sfx": "crowd cheering, ball kick"}]}

Split into start / status / fetch on purpose. A shot takes minutes and the
whole job most of an hour; this PC kills idle background processes when RAM
runs out, which once cost a run. So `start` only launches the job inside the
Studio (nohup) and returns, the GPU keeps working with nothing on this side
holding a connection, and `fetch` collects the results and switches the
Studio back to CPU — the step that stops the free GPU allowance draining.

Video: Wan2.2-TI2V-5B (open weights, fits an L4 with CPU offload), vertical
704x1280, 121 frames = ~5 s at 24 fps.
Sound: MMAudio generates audio synced to each clip (kicks, crowd, whistle)
from the clip itself plus a text hint.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REMOTE = "videogen"

REMOTE_RUNNER = r'''
import json, os, subprocess, sys, time, torch
from diffusers import AutoencoderKLWan, WanPipeline
from diffusers.utils import export_to_video

cfg = json.load(open("shots.json"))
os.makedirs("out", exist_ok=True)
log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)

model = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
vae = AutoencoderKLWan.from_pretrained(model, subfolder="vae", torch_dtype=torch.float32)
pipe = WanPipeline.from_pretrained(model, vae=vae, torch_dtype=torch.bfloat16)
pipe.enable_model_cpu_offload()
negative = "blurry, low quality, distorted limbs, extra limbs, deformed paws, text, watermark, static frame"

for s in cfg["shots"]:
    dst = f"out/{s['id']}.mp4"
    if os.path.exists(dst):
        continue
    log(f"video {s['id']}")
    frames = pipe(prompt=f"{s['prompt']}. {cfg.get('style', '')}", negative_prompt=negative,
                  height=1280, width=704, num_frames=121, guidance_scale=5.0,
                  num_inference_steps=int(cfg.get("steps", 40))).frames[0]
    export_to_video(frames, dst, fps=24)
    log(f"done {s['id']}")

del pipe; torch.cuda.empty_cache()

for s in cfg["shots"]:
    src, dst = f"out/{s['id']}.mp4", f"out/{s['id']}_sfx.mp4"
    if os.path.exists(dst) or not s.get("sfx"):
        continue
    log(f"sound {s['id']}")
    subprocess.run([sys.executable, "MMAudio/demo.py", "--duration", "5", "--video", src,
                    "--prompt", s["sfx"], "--output", "out/sfx"], check=False)
    made = [f for f in os.listdir("out/sfx") if f.startswith(s["id"]) and f.endswith(".mp4")] if os.path.isdir("out/sfx") else []
    if made:
        os.replace(f"out/sfx/{made[0]}", dst)
log("ALL DONE")
'''

SETUP = (
    "pip install -q -U diffusers transformers accelerate ftfy imageio imageio-ffmpeg > /dev/null 2>&1; "
    "[ -d MMAudio ] || (git clone -q https://github.com/hkchengrex/MMAudio.git && pip install -q -e MMAudio > /dev/null 2>&1)"
)


def studio():
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("LIGHTNING_") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    from lightning_sdk import Studio
    # A dedicated Studio: the default scratch one wedged in "requesting machine"
    # on 2026-10-02 and answered every GPU start with 403, while a fresh Studio
    # on the same account started an L4 first time.
    return Studio(name=os.environ.get("LIGHTNING_STUDIO", "videogen"), teamspace="default-project",
                  user=os.environ["LIGHTNING_USERNAME"], create_ok=True)


def start(shots_path):
    from lightning_sdk import Machine
    s = studio()
    import time
    # A start already in flight shows as Pending; calling start() again then
    # raises, so wait it out (up to 15 min) instead.
    for _ in range(90):
        if str(s.status) != "Pending":
            break
        time.sleep(10)
    print(f"Studio is {s.status} on {s.machine}; making sure it is on an L4 GPU...")
    if str(s.status) != "Running":
        s.start(Machine.L4)
    elif "L4" not in str(s.machine):
        s.switch_machine(Machine.L4)
    s.run(f"mkdir -p {REMOTE}")
    runner = ROOT / "temp" / "videogen_runner.py"
    runner.parent.mkdir(exist_ok=True)
    runner.write_text(REMOTE_RUNNER, encoding="utf-8")
    s.upload_file(str(runner), f"{REMOTE}/runner.py", progress_bar=False)
    s.upload_file(shots_path, f"{REMOTE}/shots.json", progress_bar=False)
    s.run(f"cd {REMOTE} && nohup sh -c '{SETUP}; python runner.py' > run.log 2>&1 &")
    print("launched - check with: status")


def status():
    s = studio()
    print(f"Studio: {s.status} on {s.machine}")
    if str(s.status) == "Running":
        print(s.run(f"cd {REMOTE} 2>/dev/null && tail -n 6 run.log; ls out 2>/dev/null | tr '\\n' ' '"))


def fetch(out_dir):
    from lightning_sdk import Machine
    s = studio()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    try:
        names = s.run(f"ls {REMOTE}/out 2>/dev/null").split()
        for n in [n for n in names if n.endswith(".mp4")]:
            s.download_file(f"{REMOTE}/out/{n}", str(out / n))
            print("got", n)
    finally:
        s.switch_machine(Machine.CPU)
        print("Studio back on CPU")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"start": lambda: start(sys.argv[2]), "status": status, "fetch": lambda: fetch(sys.argv[2])}[cmd]()
