# Public-site film sources

The website uses `../video/claude`, revision `5672fd8`, directly. It runs independently of that source directory.

- `compositions/s3-agents.html`: original 393 × 669 cards, radius 950, eleven slots, sampled continuous acceleration curve and camera sequence. `cinema.js` adds dragging, keyboard selection and a stable interactive camera. Six planned Agents are labelled “即将接入” and have no fabricated working conversations.
- `compositions/s4-features.html`: original 393 × 852 phone UI, send/ink, permissions/reminders, full-page navigation, quadratic file flight, selection spread, toolbar morph, card rise and copper quota coin. `film.js` adds local controls, per-file downloads, all five creation choices and the third review file.
- `compositions/s2-pair.html`: original raised/recessed pairing page, scanner, recognition and connection receipt. The displayed QR is demonstration artwork; it does not pair a computer.
- `assets/orbis-ui.css`, `assets/phone3d.js`: original tokens, icons and current phone mesh. Mesh styles are in `../phone3d.css`.
- `assets/brand`, `assets/agents`, `assets/icons`: original artwork. Agent notices are in `agents/NOTICES.txt`.

`film-markup.js`, `film-source.css` and `film-timeline.js` hold the transplanted source. Inline presentation is externalized, CSS selectors are scoped, and the pairing surface mask is a local SVG. The CSP is unchanged. Page wrappers and feature controls are in `film.css` and `film.js`; keep web interaction changes in these wrappers and controls.

Playback uses the original durations, easing and cameras. Manual mode holds a complete phone and starts each operation at its usable state. Offscreen/hidden playback pauses; reduced motion settles actions immediately. Every demo object stays local. Download publication still uses the real site API.

GSAP 3.15.0 is vendored at `../vendor/gsap.min.js` from the installed HyperFrames runtime. The original copyright/license header is preserved; see `../vendor/NOTICE.txt`. The site ships no video renderer, remote font, CDN request, music or audio.
