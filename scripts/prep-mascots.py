"""Run once on the raw 1254px exports. Safe to re-run: already-prepared 512px images are skipped.
Icons are regenerated from nib.webp every run."""
# scripts/prep-mascots.py — one-off: crop the baked caption, square, resize, write webp + icons.
import sys, pathlib
from PIL import Image
root = pathlib.Path(__file__).resolve().parents[1]
src_dir = root / 'app' / 'public' / 'mascots'
icons = root / 'app' / 'public' / 'icons'; icons.mkdir(exist_ok=True)
for p in sorted(src_dir.glob('*.webp')):
    im = Image.open(p).convert('RGB')
    if im.size == (512, 512):
        print('skip', p.name, '(already prepared)'); continue
    w, h = im.size
    im = im.crop((0, 0, w, int(h * 0.90)))          # drop the caption strip
    side = min(im.size); l = (im.width - side) // 2; t = (im.height - side) // 2
    im = im.crop((l, t, l + side, t + side)).resize((512, 512), Image.LANCZOS)
    im.save(p, 'WEBP', quality=88, method=6)
    print('wrote', p.name, im.size)
nib = Image.open(src_dir / 'nib.webp').convert('RGBA')
for s in (192, 512):
    nib.resize((s, s), Image.LANCZOS).save(icons / f'icon-{s}.png')
print('icons written')
