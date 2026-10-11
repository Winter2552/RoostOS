# Roost brand guide

Roost is the front door to a home server. The brand is calm, black and cream, a little playful, and built in-house: no outside design tools, icon sets or image hosts.

## The mark
A `>` prompt and a cursor block with a rounded top-right corner and an eye, so the cursor reads as a small bird. Files in `logo/`:

| File | Use |
| --- | --- |
| `roost.svg`, `roost-on-cream.svg` | The icon, cream on black or black on cream |
| `wordmark.svg` | "roost" in Space Mono Bold, followed by the bird |
| `nest.svg`, `roostflix.svg`, `glint.svg`, `nova.svg` (and `-on-cream`) | App marks |

Rules:
- Redraw nothing. Use the SVGs as they are; the shapes are the same ones in `public/logo.svg`.
- Leave clear space around the mark equal to the width of the chevron.
- Minimum size: 16 px for the favicon, 24 px elsewhere.
- Only cream on black or black on cream. No gradients, shadows, outlines or tilting.
- The wordmark is lowercase: "roost". In sentences the name is "Roost".

## App marks
Every app mark is the same chevron and bird plus one detail only that app has:
- **Roostflix**: a play button on the bird.
- **Nest**: a nest under the bird.
- **Glint**: the eye becomes a spark, with a small twinkle beside it.
- **Nova**: an orbit ring around the bird and a planet.

New apps follow the same rule: keep the chevron and the bird, add one detail, draw it with the same stroke weights.
Names are written Roost, Roostflix, Nest, Glint, Nova. Jellyfin keeps its own name.

## Colour
| Name | Hex | Use |
| --- | --- | --- |
| Night | `#0a0a0a` | Backgrounds |
| Panel | `#121212` | Cards |
| Cream | `#f2efe9` | Text, lines, the mark |
| Muted | `#9a978f` | Labels, secondary text |
| OK | `#b8f5a0` | Online, success only |
| Alert | `#ff8a7a` | Offline, errors only |

Green and red are for status, never decoration. Cream on night is the whole identity.

## Type
- Headlines and body: Space Grotesk.
- Labels, numbers, the wordmark: Space Mono, uppercase labels with a little letter spacing.
- Both load from Google Fonts with system fonts as the fallback.

## Look
Outlined cards with a hard offset shadow, thin lines, plenty of empty space. If a screen looks busy, remove something.

## Voice
Short, calm, plain. Say what happened and what to do next. No exclamation marks, no jargon, no "oops". Friendly, in small doses: "Welcome to the Roost", "See you inside".

## Motion
All motion is CSS, runs once, and has a reason.
- **Screen switch** (`public/motion.js`): moving between Roost, Nest, Glint and Nova builds the app's mark in the middle of the screen for about 1.3 s, with the app's name. Only on a change of app.
- **Dashboard**: app cards rise in once, press down when tapped, and a status dot pings once the first time its app shows as online.
- **Sign-in**: the mark draws itself once.
- **Email**: the header types "roost" and the bird pops up, once.
- Nothing loops. Everything is off when the device asks for reduced motion.

## Email
Invites, password resets and test emails go out as a styled version with a plain-text version beside it (`src/email-template.js`, `src/mail.js`). The header GIF is inside the email, so nothing loads from outside when it is opened. Mail apps that don't animate GIFs (Outlook desktop) show the first frame, a plain black bar, and the title below carries the message. To change the header, edit and run `scripts/make-email-header.py` (needs Pillow).

## Graphics
In `graphics/` (HTML source and PNG): `social-card` (1200x630, for link previews), `banner` (1600x400), `app-marks`. Re-render the PNGs from the HTML with any browser screenshot tool when the marks change.
