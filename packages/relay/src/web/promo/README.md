# Public-site promo assets

Adapted from the local Orbis film project `../video/claude`, reference commit `0803434`:

- `compositions/s3-agents.html`: 11-card ring, Agent order, example tasks and front/back geometry.
- `compositions/s4-features.html`: seven website chapters adapted from the phone demonstrations, with browser controls.
- `assets/orbis-ui.css`: classic-light material, icon references and brand colors.
- `assets/phone3d.js`: titanium mesh, bezel, back, lenses and side buttons. The website keeps styles in `../phone3d.css` to respect its CSP.
- `assets/brand`: original brand pixels, resampled with macOS `sips`; no replacement logo geometry.
- `assets/agents` and `assets/icons`: original SVG files. Third-party notices are in [agents/NOTICES.txt](agents/NOTICES.txt).

The website is independent of the film project at runtime. It ships no video renderer, remote fonts, CDN scripts, sound or third-party runtime dependencies. Six film Agents are previews, not availability claims. Demo actions are local and do not connect to a Host.
