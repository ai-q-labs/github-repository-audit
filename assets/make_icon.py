"""Generate the Actor store icon.

Apify renders icons at 76x76 in the store grid, so the design has to survive heavy
downscaling: a few large shapes, high contrast, no fine detail.

Motif: a package box with an arrow leaving it. The cyan box is what the registry
still hands you; the red arrow is the repository quietly moving somewhere else,
ending in a red dot that is nowhere near the box. Underneath, a short cyan bar
sits where the box's shadow would be - the record the registry kept, unchanged
while everything above it moved.

Palette is shared with the other Ai-Q Labs Actors so the shelf reads as one publisher.
"""
import pathlib

from PIL import Image, ImageDraw

SCALE = 4
S = 512 * SCALE
OUT = pathlib.Path(__file__).parent / "icon.png"

BG = (13, 20, 38)
CYAN = (56, 189, 248)
RED = (244, 63, 94)

img = Image.new("RGB", (S, S), BG)
d = ImageDraw.Draw(img)

# The box: what you installed, still sitting there looking fine.
box_left = int(S * 0.145)
box_top = int(S * 0.250)
box_size = int(S * 0.360)
stroke = int(S * 0.055)
d.rounded_rectangle(
    [box_left, box_top, box_left + box_size, box_top + box_size],
    radius=int(S * 0.045), outline=CYAN, width=stroke,
)
# The seam across the lid, so the square reads as a package and not as a frame.
d.line(
    [box_left, box_top + int(box_size * 0.36), box_left + box_size, box_top + int(box_size * 0.36)],
    fill=CYAN, width=stroke,
)

# The arrow: the repository leaving, in red, at 45 degrees out of the box's corner.
tail_x = box_left + int(box_size * 0.72)
tail_y = box_top + int(box_size * 0.30)
head_x = int(S * 0.790)
head_y = int(S * 0.245)
d.line([tail_x, tail_y, head_x - int(S * 0.045), head_y + int(S * 0.045)], fill=RED, width=stroke)
head = int(S * 0.105)
d.polygon(
    [(head_x, head_y), (head_x - head, head_y + int(head * 0.30)), (head_x - int(head * 0.30), head_y + head)],
    fill=RED,
)

# The dot: where it actually ended up, far from the box.
dot_r = int(S * 0.052)
d.ellipse([head_x - dot_r, int(S * 0.700) - dot_r, head_x + dot_r, int(S * 0.700) + dot_r], fill=RED)

# The registry's record: still there, still saying nothing, under the box.
bar_top = int(S * 0.700)
bar_h = int(S * 0.070)
d.rounded_rectangle(
    [box_left, bar_top, box_left + int(box_size * 0.95), bar_top + bar_h],
    radius=bar_h // 2, fill=CYAN,
)

img = img.resize((512, 512), Image.Resampling.LANCZOS)
img.save(OUT, "PNG")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

# Store-grid preview: this is the size that actually decides whether it reads.
preview = img.resize((76, 76), Image.Resampling.LANCZOS).resize((228, 228), Image.Resampling.NEAREST)
preview.save(OUT.parent / "icon_preview_76px.png", "PNG")
print("wrote 76px preview (upscaled 3x for inspection)")
