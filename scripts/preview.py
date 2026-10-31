"""Gallery previews for a submission form: up to 8 images at 3:2, one caption each, 140 max.

Copy this file to <project>/scripts/preview.py and fill in the CONFIG block. Nothing
below CONFIG normally needs editing.

Two kinds of shot:
  page   a live URL rendered at a 3:2 viewport, scrolled so a CSS selector sits at the top
  still  an existing PNG (a b-roll end frame, a screenshot) letterboxed to 3:2 in its own
         background colour, so nothing is cropped and the bars are invisible

Output: <out>/N-name.png in story order plus <out>/captions.md, one fenced block per image
holding the caption and nothing else. The character count is asserted here and printed to
the terminal only. It never goes in captions.md and never next to a caption in chat,
because a count that sits beside a caption gets pasted into the form with it.

    python scripts/preview.py
"""
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------ CONFIG
OUT = ROOT / 'preview'                           # committed: the Devpost gallery and the README use it
URL = None                                       # no live page: every shot is a still
W, H = 1500, 1000
STILLS = ROOT / 'tmp' / 'preview_src'            # frames pulled from the raw b-roll (no captions burned in)
WAIT_FOR_VIDEO = False

SHOTS = [
    ('1-hero',        'still', 'hero'),
    ('2-live-bet',    'still', 'live-bet'),
    ('3-card-fills',  'still', 'card-fills'),
    ('4-second-look', 'still', 'second-look'),
    ('5-payout',      'still', 'payout'),
    ('6-refund',      'still', 'refund'),
    ('7-results',     'still', 'results'),
    ('8-codex',       'still', 'codex'),
]

CAPTIONS = {
    '1-hero':        "Call It watches your game through OBS and runs the prediction bets in your Twitch chat. Any channel, no Affiliate needed.",
    '2-live-bet':    "Live on Twitch: a boss appears and Call It opens the bet on its own. Chat bets with !1 or !2; here my main account plays the viewer.",
    '3-card-fills':  "The overlay card on stream fills as points come in, then locks near the end of the fight.",
    '4-second-look': "Every payout gets a second look: gpt-5.4-mini proposes the result, gpt-6.1-sol checks the frames before anyone is paid.",
    '5-payout':      "The payout lands in chat with a clip link, and a marker goes into the VOD. The agent makes all three Twitch calls itself.",
    '6-refund':      "When it cannot see a result it refunds. It had opened a bet while I talked to a quest-giver, saw no fight, and returned every stake.",
    '7-results':     "Graded against chess.com game records on a 2.4-hour stream it had never seen: 10 of 12 payouts matched, 8 bets refunded.",
    '8-codex':       "Built in one OpenAI Codex thread from SPEC.md and AGENTS.md: 18 prompts, 26 commits, 72 tests. Every prompt is in the repo.",
}
BG_OVERRIDE = {'3-card-fills': (10, 13, 12), '4-second-look': (10, 13, 12)}   # frames whose corner pixel is not a background
# ------------------------------------------------------------------ END CONFIG

for k, c in CAPTIONS.items():
    assert len(c) <= 140, f'{k}: {len(c)} characters, limit is 140'
assert [n for n, _, _ in SHOTS] == list(CAPTIONS), 'SHOTS and CAPTIONS must list the same names in the same order'
assert len(SHOTS) <= 8, 'eight is the ceiling; a gallery is a story, not an archive'

OUT.mkdir(parents=True, exist_ok=True)

pages = [(n, src) for n, kind, src in SHOTS if kind == 'page']
if pages and URL:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=1, color_scheme='dark')
        pg = ctx.new_page()
        pg.goto(URL, wait_until='domcontentloaded', timeout=60_000)
        pg.evaluate('document.fonts.ready')
        if WAIT_FOR_VIDEO:
            pg.wait_for_function("[...document.querySelectorAll('video')].every(v=>v.readyState>=2)", timeout=40_000)
        pg.wait_for_timeout(600)
        for name, sel in pages:
            if sel:
                pg.evaluate(f"window.scrollTo(0, document.querySelector('{sel}').getBoundingClientRect().top + window.scrollY - 28)")
            else:
                pg.evaluate('window.scrollTo(0, 0)')
            pg.wait_for_timeout(700)          # entrance animations settle
            pg.screenshot(path=str(OUT / f'{name}.png'))
        b.close()

for name, kind, src in SHOTS:
    if kind != 'still':
        continue
    im = Image.open(STILLS / f'{src}.png').convert('RGB')
    bg = BG_OVERRIDE.get(name) or im.getpixel((2, 2))        # the frame's own background, unless overridden
    target_h = im.width * 2 // 3
    if im.height >= target_h:                                  # already 3:2 or taller: crop height
        top = (im.height - target_h) // 2
        canvas = im.crop((0, top, im.width, top + target_h))
    else:                                                      # wider than 3:2: letterbox
        canvas = Image.new('RGB', (im.width, target_h), bg)
        canvas.paste(im, (0, (target_h - im.height) // 2))
    canvas.save(OUT / f'{name}.png')

lines = ['# Image gallery, upload in this order', '',
         'One caption per image. Copy the block contents only.', '']
for name, _, _ in SHOTS:
    lines += [f'## {name}.png', '', '```', CAPTIONS[name], '```', '']
(OUT / 'captions.md').write_text('\n'.join(lines), encoding='utf-8')

for name, _, _ in SHOTS:
    f = OUT / f'{name}.png'; im = Image.open(f)
    ratio = im.width / im.height
    ok = 'ok ' if abs(ratio - 1.5) < 0.01 and f.stat().st_size < 5_000_000 else 'BAD'
    print(f'  {ok} {f.name:<22} {im.width}x{im.height}  {f.stat().st_size // 1024:>4} KB   caption {len(CAPTIONS[name]):>3}/140')
print(f'\n{len(SHOTS)} images + captions.md in {OUT.relative_to(ROOT)}')
