# E-LAB VR27 Listening Rooms

A static website with seven interactive rooms from E-LAB's VR27 auralisation tool. Each room is a 3D model in the
browser with measured or simulated ambisonic room impulse responses on a grid of listening points. Visitors walk
around, switch acoustic treatments and hear the difference on headphones.

Live site (once Pages is on): https://little-noizes.github.io/vr27-rooms/

| Room | Folder | IRs | What you can switch |
|---|---|---|---|
| Yoga Studio | `rooms/yoga-studio` | Simulated (Treble), 2nd order, 38 points, 3 sources | 4 treatments, L/R speakers, music and voice levels |
| Operating Theatre | `rooms/operating-theatre` | Simulated (Treble), 2nd order played at 1st, 36 points, 8 sources (6 baked into two FOA loop beds, 2 live) | Plasterboard or Bioguard ceiling, 5 events, source levels |
| Boardroom | `rooms/boardroom` | Simulated, 1st order, 110 points | Curtain off/on, speech or music |
| Classroom | `rooms/classroom` | Measured (existing) and simulated (acoustic ceiling), 130 points | Ceiling option, LAP |
| VR Room | `rooms/vr-room` | Measured, 25 points, 2 monitors | Left, right, stereo, mono |
| Great Hall | `rooms/great-hall` | Measured, 169 points (demo pairing, IRs from another hall) | Seat or blended IRs, LAP |
| Newton's Cenotaph | `rooms/newtons-cenotaph` | Visual only, acoustic model in progress | Viewpoints |

## Layout

```
index.html            landing page (room cards)
assets/               logo, favicon, card images
shared/irpack.js      IR and LAP-bin loader used by every room engine (reads packed files)
shared/nav.js         "All rooms" link added to every room page
rooms/<room>/         one self-contained viewer per room
tools/                pack_room.py, patch_engine.py, patch_lap.py (site build helpers, not served)
```

## IR packs

GitHub Pages limits files to 100 MB and the site to about 1 GB, and every IR as its own file means hundreds of
requests. `tools/pack_room.py` concatenates each scenario and source's IRs into ~4 MB 16-bit WAV packs, with 256 zero
samples between IRs. Manifest entries point into a pack as `packs/<name>.wav#<start>,<length>,<fs>`, and
`shared/irpack.js` decodes each pack once and slices out the IRs. LAP parameter bins are packed the same way
(`params/<scenario>.f32#<offset>,<count>`).

To add or update a room: copy its built viewer into `rooms/<name>/`, then

```
python tools/pack_room.py rooms/<name>/audio --params          # --manifest manifest_S01.json, --base irs as needed
python tools/patch_engine.py rooms/<name>/vr27*.js
python tools/patch_lap.py rooms/<name>/lap.js                   # rooms with LAP only
```

and add a card to `index.html` (image 960 x 600 in `assets/rooms/`).

## Run locally

```
python -m http.server 8000
```

then open http://localhost:8000/ in Chrome or Edge. Pages must be served over http(s), not opened as files.

## Publish

Public repo with GitHub Pages from the `main` branch root. No Git LFS: Pages does not serve LFS files. `.nojekyll`
keeps Pages from processing the files. Total size is about 710 MB (Operating Theatre adds about 170 MB).

© 2026 E-LAB Consulting

## Operating Theatre notes

Not packed with `tools/pack_room.py`: its packs (`audio/packs`, 6 IRs each) and baked beds (`audio/beds/<bed>/<scenario>/<Rnn>.opus`, 4-channel Ogg Opus) are written by `projects/07 OperTheatre/03_Build/build_web.py`. The model is the Charité scan by Digital Surgery (CC BY-NC 4.0), published with their permission; keep the attribution on the room page and the landing page.
