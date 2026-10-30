#!/usr/bin/env python3
"""
Frames and sound for the v2 story short. Driven by utils/short-style-v2.js.

  python compose_short.py analyze <image>...    faces + sharpness per image, JSON on stdout
  python compose_short.py render  <plan.json>   video-only mp4 at plan["videoOut"]
  python compose_short.py audio   <plan.json>   music + sfx WAVs at plan["musicOut"], plan["sfxOut"]

Why this exists. The v1 shorts fitted each landscape photo into a thin band
over a blurred copy of itself (two-thirds of the screen was blur), drifted it
by 10-14 pixels and hard-cut every 3.5 seconds, with no sound but the voice.
Viewers read that as a slideshow and swipe. Here every shot is a full-frame
9:16 crop framed on the subject's face, moved with a sub-pixel affine warp
(ffmpeg's zoompan rounds to whole pixels and judders on slow moves), cut on
the narration's own word timings, graded to one look, and scored.

Everything is generated locally: the music and effects are synthesised here,
so nothing needs a licence and nothing can be claimed.
"""

import json
import math
import os
import subprocess
import sys
import wave

import cv2
import numpy as np

W, H, FPS = 1080, 1920, 30
SR = 44100

MODELS = os.environ.get('FACE_MODELS_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data', 'face-models')
YUNET = os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx')
SFACE = os.path.join(MODELS, 'face_recognition_sface_2021dec.onnx')
SAME_PERSON = 0.363      # SFace's published cosine threshold


# ---------------------------------------------------------------- analyze

def analyze(paths):
    """Faces per photo, and which of them is the story's SUBJECT.

    Finding faces is not enough. In the first v2 test the biggest face in a
    "Harry Kane" photo was a child mascot, and in another a teammate: every
    photo of a story is of its subject, but not every face in it is. So each
    face is embedded (SFace) and compared across all the story's photos; the
    face that turns up in the most OTHER photos is the subject, and each crop
    follows that face. Falls back to the old detector when the models are
    missing, where the subject is the face that clearly dominates its photo.
    """
    if not (os.path.exists(YUNET) and os.path.exists(SFACE)):
        return analyze_haar(paths)
    det = cv2.FaceDetectorYN.create(YUNET, '', (320, 320), 0.8, 0.3, 50)
    rec = cv2.FaceRecognizerSF.create(SFACE, '')
    info, faces = {}, []
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        h, w = img.shape[:2]
        s = min(1.0, 1280 / max(w, h))
        small = cv2.resize(img, None, fx=s, fy=s) if s < 1 else img
        det.setInputSize((small.shape[1], small.shape[0]))
        _, rows = det.detect(small)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        info[p] = {'w': w, 'h': h, 'faces': [], 'subject': None, 'sharp': float(cv2.Laplacian(gray, cv2.CV_64F).var())}
        for row in (rows if rows is not None else []):
            box = [float(v / s) for v in row[:4]]
            info[p]['faces'].append(box)
            # Tiny crowd faces embed badly; they can be faces, not candidates.
            if row[2] < 40:
                continue
            feat = rec.feature(rec.alignCrop(small, row))
            faces.append({'path': p, 'box': box, 'feat': feat})
        info[p]['faces'].sort(key=lambda b: -b[2] * b[3])

    same = lambda a, b: rec.match(a, b, cv2.FaceRecognizerSF_FR_COSINE)
    # Support = in how many other photos this face reappears.
    for f in faces:
        f['support'] = len({g['path'] for g in faces if g['path'] != f['path'] and same(f['feat'], g['feat']) >= SAME_PERSON})
    ref = max(faces, key=lambda f: (f['support'], f['box'][2] * f['box'][3]), default=None)
    if ref is None or ref['support'] == 0:
        # One photo, or nobody repeats: the dominant face is the best guess.
        for p, m in info.items():
            fs = m['faces']
            if len(fs) == 1 or (len(fs) > 1 and fs[0][2] * fs[0][3] >= 2.5 * fs[1][2] * fs[1][3]):
                m['subject'] = fs[0]
    else:
        # Average the reference with its matches: one bad angle cannot steer it.
        matched = [g['feat'] for g in faces if same(ref['feat'], g['feat']) >= SAME_PERSON]
        centre = np.mean(np.vstack(matched), axis=0, keepdims=True).astype(np.float32)
        for p, m in info.items():
            best = max((f for f in faces if f['path'] == p), key=lambda f: same(centre, f['feat']), default=None)
            if best is not None and same(centre, best['feat']) >= SAME_PERSON:
                m['subject'] = best['box']
                m['match'] = float(same(centre, best['feat']))
    print(json.dumps(info))


def analyze_haar(paths):
    front = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
    out = {}
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        h, w = img.shape[:2]
        s = min(1.0, 960 / max(w, h))
        gray = cv2.equalizeHist(cv2.cvtColor(cv2.resize(img, None, fx=s, fy=s), cv2.COLOR_BGR2GRAY))
        side = max(24, int(min(gray.shape) * 0.04))
        found = front.detectMultiScale(gray, 1.1, 6, minSize=(side, side))
        if len(found) == 0:
            found = profile.detectMultiScale(gray, 1.1, 6, minSize=(side, side))
        faces = sorted(([float(x / s), float(y / s), float(fw / s), float(fh / s)] for (x, y, fw, fh) in found),
                       key=lambda f: -f[2] * f[3])
        sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        out[p] = {'w': w, 'h': h, 'faces': faces[:5], 'sharp': sharp}
    print(json.dumps(out))


# ---------------------------------------------------------------- look

def s_curve(x, k):
    sig = lambda v: 1.0 / (1.0 + np.exp(-v))
    lo, hi = sig(-k / 2), sig(k / 2)
    return (sig(k * (x - 0.5)) - lo) / (hi - lo)


def grade(img, look):
    f = img.astype(np.float32) / 255.0
    if look == 'ancient':
        # Warm, aged, low saturation: marble, coins and oil paintings from
        # different museums end up looking like one film.
        lum = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)[..., None] / 255.0
        f = f * 0.5 + lum * 0.5
        shadow = np.array([0.30, 0.40, 0.55], np.float32)    # BGR: brown
        light = np.array([0.86, 0.96, 1.05], np.float32)     # BGR: cream
        f = f * (shadow + (light - shadow) * lum) * 1.18
        f = s_curve(np.clip(f, 0, 1), 5.0)
    else:
        # Football: punchy contrast, a little extra colour, cool shadows and
        # warm highlights so stadium photos from different matches match.
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[..., 1] = np.clip(hsv[..., 1] * 1.15, 0, 255)
        f = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32) / 255.0
        f = s_curve(f, 5.5)
        lum = f.mean(axis=2, keepdims=True)
        f = f + (1 - lum) * np.array([0.035, 0.012, -0.015], np.float32) \
              + lum * np.array([-0.025, 0.0, 0.03], np.float32)
    return (np.clip(f, 0, 1) * 255).astype(np.uint8)


def frame_mask(look):
    """Vignette plus darker top and bottom bands: the headline sits at the top
    and YouTube's own title and buttons sit at the bottom, and both read better
    over a darker picture."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    nx, ny = x / W - 0.5, y / H - 0.5
    r2 = (nx / 0.5) ** 2 * 0.55 + (ny / 0.5) ** 2 * 0.45
    m = 1 - (0.48 if look == 'ancient' else 0.38) * np.clip(r2, 0, 1) ** 1.5
    yy = y / H
    m *= np.where(yy < 0.24, 0.55 + 0.45 * (yy / 0.24) ** 0.8, 1.0)
    m *= np.where(yy > 0.80, 1 - 0.32 * (yy - 0.80) / 0.20, 1.0)
    return m[..., None].astype(np.float32)


def grain_frames(look, n=8):
    rng = np.random.default_rng(7)
    sigma = 0.03 if look == 'ancient' else 0.012
    frames = []
    for _ in range(n):
        g = rng.normal(0, sigma, (H // 2, W // 2)).astype(np.float32)
        frames.append(cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * 255)
    return frames


def card_canvas(img, look, accent_bgr):
    """For a photo that cannot fill 9:16 (too small, or a wide coin plate on
    white): the photo as a bordered card over a designed background — never a
    blurred copy of itself."""
    acc = np.array(accent_bgr, np.float32)
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    base = np.array([20, 18, 16] if look == 'ancient' else [22, 16, 14], np.float32)
    bg = base * (1.15 - 0.5 * y) + np.zeros((H, W, 3), np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    glow = np.exp(-(((xx - W / 2) / (W * 0.55)) ** 2 + ((yy - H * 0.46) / (H * 0.30)) ** 2))[..., None]
    bg = bg + glow * acc * 0.22
    noise = np.random.default_rng(3).normal(0, 6, (H, W, 1)).astype(np.float32)
    bg = np.clip(bg + noise, 0, 255)

    ih, iw = img.shape[:2]
    scale = min(940 / iw, 1150 / ih)
    pw, ph = int(iw * scale), int(ih * scale)
    photo = cv2.resize(img, (pw, ph), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    border = 12
    cx, cy = W // 2, int(H * 0.46)
    x0, y0 = cx - pw // 2 - border, cy - ph // 2 - border
    shadow = np.zeros((H, W), np.float32)
    shadow[y0 + 26:y0 + ph + 2 * border + 26, x0 + 10:x0 + pw + 2 * border + 10] = 1
    shadow = cv2.GaussianBlur(shadow, (0, 0), 28)[..., None]
    bg = bg * (1 - 0.7 * shadow)
    frame_col = (226, 236, 242) if look == 'ancient' else (245, 245, 245)
    bg[y0:y0 + ph + 2 * border, x0:x0 + pw + 2 * border] = frame_col
    bg[y0 + border:y0 + border + ph, x0 + border:x0 + border + pw] = photo
    return bg.astype(np.uint8)


# ---------------------------------------------------------------- render

def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3


def window_for(meta, shot):
    """The tallest 9:16 window in the source, face centred across and placed a
    little above the middle (where the eye goes in a vertical frame)."""
    w, h = meta['w'], meta['h']
    ch = min(h, w * 16 / 9) * shot.get('tight', 1.0)
    cw = ch * 9 / 16
    face = shot.get('face')
    if face:
        fx, fy = face[0] + face[2] / 2, face[1] + face[3] / 2
        cy = fy + ch * 0.10
    else:
        fx, cy = w / 2, h * 0.5
    return fx, cy, cw, ch


def render(plan):
    look = plan['look']
    accent = plan['accentBgr']
    duration = plan['duration']
    shots = plan['shots']
    punches = plan.get('punches', [])

    sources = {}
    for s in shots:
        key = (s['image'], s['mode'])
        if key in sources:
            continue
        img = cv2.imread(s['image'])
        if s['mode'] == 'card':
            img = card_canvas(grade(img, look), look, accent)
        else:
            img = grade(img, look)
        sources[key] = img

    mask = frame_mask(look)
    grains = grain_frames(look)
    proc = subprocess.Popen([plan['ffmpeg'], '-y', '-loglevel', 'error',
                             '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                             '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p',
                             plan['videoOut']], stdin=subprocess.PIPE)

    total = int(math.ceil(duration * FPS))
    idx = 0
    for n in range(total):
        t = n / FPS
        while idx < len(shots) - 1 and t >= shots[idx + 1]['start']:
            idx += 1
        shot = shots[idx]
        src = sources[(shot['image'], shot['mode'])]
        sh, sw = src.shape[:2]
        meta = {'w': sw, 'h': sh}
        u = t - shot['start']
        d = max(0.001, shot['end'] - shot['start'])

        z0, z1 = shot['zoom']
        prog = ease_out(u / min(d, 0.9)) if idx == 0 else smooth(u / d)
        zoom = z0 + (z1 - z0) * prog
        if idx > 0 and shot['transition'] == 'punch' and u < 0.22:
            zoom *= 1 + 0.16 * (1 - ease_out(u / 0.22))
        for p in punches:
            x = (t - p) / 0.32
            if 0 <= x <= 1:
                zoom *= 1 + 0.06 * math.sin(math.pi * x)

        fx, cy, cw, ch = window_for(meta, shot) if shot['mode'] == 'bleed' else (sw / 2, sh / 2, sw, sh)
        cw_z, ch_z = cw / zoom, ch / zoom
        cx = fx + shot.get('pan', 0) * cw * 0.04 * (smooth(u / d) - 0.5)
        cx = min(max(cx, cw_z / 2), sw - cw_z / 2)
        cyy = min(max(cy, ch_z / 2), sh - ch_z / 2)
        scale = W / cw_z

        # Whip pan: the outgoing shot slides out and the next slides in, with
        # horizontal motion blur proportional to the speed.
        shift, blur = 0.0, 0.0
        nxt = shots[idx + 1] if idx + 1 < len(shots) else None
        if idx > 0 and shot['transition'] == 'whip' and u < 0.16:
            k = 1 - ease_out(u / 0.16)
            shift, blur = -W * 0.55 * k, k
        elif nxt and nxt['transition'] == 'whip' and shot['end'] - t < 0.16:
            k = 1 - (shot['end'] - t) / 0.16
            shift, blur = W * 0.55 * k * k, k

        M = np.float32([[scale, 0, W / 2 - scale * cx + shift], [0, scale, H / 2 - scale * cyy]])
        frame = cv2.warpAffine(src, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        if blur > 0.05:
            k = int(9 + 90 * blur) | 1
            frame = cv2.blur(frame, (k, 1))

        f = frame.astype(np.float32) * mask + grains[n % len(grains)]
        if idx > 0 and shot['transition'] == 'punch' and u < 2 / FPS:
            a = 0.30 if u < 1 / FPS else 0.12
            f = f * (1 - a) + 255 * a
        proc.stdin.write(np.clip(f, 0, 255).astype(np.uint8).tobytes())

    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit('ffmpeg failed while encoding frames')


# ---------------------------------------------------------------- audio

def band(x, lo=None, hi=None):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    gain = np.ones_like(f)
    if lo:
        gain *= 1 / (1 + (lo / np.maximum(f, 1)) ** 4)
    if hi:
        gain *= 1 / (1 + (f / hi) ** 4)
    return np.fft.irfft(spec * gain, n=len(x))


def norm(x, peak):
    m = np.max(np.abs(x)) or 1.0
    return x / m * peak


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def music(duration, look):
    """A dark four-chord bed at 86 bpm: detuned saw pad, sub bass on 1 and 3,
    a soft kick on every beat and a quiet off-beat tick. Under a voice that is
    ducked 10dB it reads as tension, which is the job."""
    n = int(SR * (duration + 1))
    out = np.zeros(n, np.float64)
    beat = 60 / 86
    bar = 4 * beat
    prog = ([[50, 53, 57], [46, 50, 53], [48, 52, 55], [45, 49, 52]] if look == 'ancient'
            else [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]])
    pad = np.zeros(n)
    bass = np.zeros(n)
    for b in range(int(duration / bar) + 2):
        chord = prog[b % 4]
        i0 = int(b * bar * SR)
        seg = int((bar + 0.6) * SR)
        if i0 >= n:
            break
        seg = min(seg, n - i0)
        t = np.arange(seg) / SR
        env = np.minimum(1, t / 0.5) * np.minimum(1, np.maximum(0, (bar + 0.6 - t) / 0.6))
        tone = np.zeros(seg)
        for m in chord:
            for det in (-0.07, 0.0, 0.07):
                f0 = hz(m) * 2 ** (det / 12)
                for k in range(1, 7):
                    tone += np.sin(2 * np.pi * k * f0 * t + k * det * 9) / k
        pad[i0:i0 + seg] += tone * env
        for beat_i in (0, 2):
            j0 = i0 + int(beat_i * beat * SR)
            ln = min(int(beat * 1.6 * SR), n - j0)
            if ln <= 0:
                continue
            tb = np.arange(ln) / SR
            bass[j0:j0 + ln] += np.sin(2 * np.pi * hz(chord[0] - 24) * tb) * np.exp(-2.2 * tb)
    pad = band(pad, lo=90, hi=1100)
    kick = np.zeros(n)
    hat = np.zeros(n)
    rng = np.random.default_rng(11)
    for i in range(int(duration / beat) + 2):
        j0 = int(i * beat * SR)
        ln = min(int(0.32 * SR), n - j0)
        if ln <= 0:
            break
        tk = np.arange(ln) / SR
        freq = 45 + 75 * np.exp(-30 * tk)
        kick[j0:j0 + ln] += np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-9 * tk)
        h0 = j0 + int(beat / 2 * SR)
        hl = min(int(0.05 * SR), n - h0)
        if hl > 0:
            hat[h0:h0 + hl] += rng.normal(0, 1, hl) * np.exp(-60 * np.arange(hl) / SR)
    hat = band(hat, lo=6000)
    mix = norm(pad, 0.32) + norm(bass, 0.45) + norm(kick, 0.40) + norm(hat, 0.05)
    fade = np.minimum(1, np.arange(n) / (SR * 1.0)) * np.minimum(1, (n - np.arange(n)) / (SR * 1.5))
    return norm(mix * fade, 0.7)


def impact(length=1.4):
    t = np.arange(int(SR * length)) / SR
    freq = 32 + 60 * np.exp(-6 * t)
    boom = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-3.2 * t)
    rng = np.random.default_rng(5)
    crack = band(rng.normal(0, 1, len(t)), hi=2500) * np.exp(-18 * t)
    return norm(boom + 0.5 * norm(crack, 1), 1.0)


def whoosh(length=0.42):
    t = np.arange(int(SR * length)) / SR
    rng = np.random.default_rng(9)
    noise = band(rng.normal(0, 1, len(t)), lo=500, hi=5000)
    env = np.sin(np.pi * np.clip(t / length, 0, 1)) ** 2 * np.clip(t / (length * 0.7), 0, 1)
    return norm(noise * env, 1.0)


def riser(length):
    t = np.arange(int(SR * length)) / SR
    rng = np.random.default_rng(13)
    noise = band(rng.normal(0, 1, len(t)), lo=1500)
    freq = 180 * (8 ** (t / length))
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SR)
    env = (t / length) ** 2
    return norm((0.6 * norm(noise, 1) + 0.4 * tone) * env, 1.0)


def place(track, clip, at, gain):
    i0 = int(at * SR)
    if i0 < 0:
        clip, i0 = clip[-i0:], 0
    end = min(len(track), i0 + len(clip))
    if end > i0:
        track[i0:end] += clip[:end - i0] * gain


def write_wav(path, x):
    data = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(data.tobytes())


def audio(plan):
    duration = plan['duration']
    write_wav(plan['musicOut'], music(duration, plan['look']))
    sfx = np.zeros(int(SR * (duration + 1)))
    place(sfx, impact(), 0.0, 0.9)
    for s in plan['shots'][1:]:
        place(sfx, whoosh(), s['start'] - 0.28, 0.32)
    for p in plan.get('punches', []):
        place(sfx, impact(0.6), p, 0.45)
    if plan.get('payoff'):
        length = min(2.0, plan['payoff'] - 0.5)
        if length > 0.6:
            place(sfx, riser(length), plan['payoff'] - length, 0.35)
    write_wav(plan['sfxOut'], sfx)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'analyze':
        analyze(sys.argv[2:])
    else:
        with open(sys.argv[2], encoding='utf-8') as fh:
            plan = json.load(fh)
        {'render': render, 'audio': audio}[mode](plan)
