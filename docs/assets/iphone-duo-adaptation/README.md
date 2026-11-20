# Orbis iPhone Duo adaptation campaign — local review

Four 1800 × 2400 px portrait promotional concepts, independently composed from the current Orbis UI screenshots and the local Three.js iPhone Duo model. The footer explicitly distinguishes these independent interface/layout illustrations from official Apple advertising.

## Generated posters

- `01-wide-workspace.png` — unfolded landscape layout: session directory beside the conversation.
- `02-fold-reading.png` — partially folded portrait reading layout.
- `03-expanded-reading.png` — unfolded portrait chat illustration: title at the top, continuous transcript, and composer at the bottom. No fold-reading controls.
- `04-closed-cover.png` — fully folded cover display with the session list and common entry points.
- `00-campaign-overview.jpg` — four-poster review sheet.

**Rights review before public promotion.** The 3D device model and its product design, original textures and Apple trademarks belong to their respective rights holders. The checked-in adjacent model attribution states that its MIT-covered viewer code does not grant permission to redistribute or commercially use the Apple-sourced model. This is a local visual review, not an assertion of commercial-use permission. Confirm the relevant Apple/model rights and image permissions before publishing; replace the model with an appropriately licensed original device model when clearance is unavailable. The interface screenshots are local preview material. The landscape and cover use local iPhone Duo screenshots. The unfolded portrait artwork recomposes the November 17 half-open screenshot to match the regular chat layout in `ChatView.swift` and `ChatHeaderView.swift`; it is not a full-open device capture. The half-open artwork combines the local reading and controls images. No external image download is used.

## Re-render locally

Run `node .artifacts/iphone-duo-promo-20261118/render.mjs` from the repository root. This uses the adjacent `Orbis-QA` Playwright installation, the locally installed Chrome, the bundled Three.js renderer, and the local model. WebGL rendering and the final 1800 × 2400 px PNGs are verified by the script.

The exact device-model source, provenance, SHA-256 and applicable model/code notices are preserved in `../../../.artifacts/duo-layout-design-20261117/assets/model-attribution.txt` and `model-code-LICENSE.txt`. The native PNGs in this folder are generated output; renderer and visual evidence stay together in `.artifacts/iphone-duo-promo-20261118/`.
