# RISE Motordrome

A browser sim of the planned Rwandan Formula 1 circuit in Bugesera, built with three.js (WebGPU, with a WebGL 2 fallback). You drive or ride along in an F1 car on a 6 km, 17-turn lap with 197 m of climbing, beside Lake Kidogo.

Everything is generated in code: the terrain, track, stands, trees, cars and all the sound. The only downloads are three.js from jsDelivr and two Google Fonts.

## Run it locally

The site is static files with no build step. From this folder, serve it over HTTP (WebGPU needs `localhost` or HTTPS):

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>.

## Host it on GitHub Pages

1. Create a public repository, for example `mrsmickers/rise-motordrome`.
2. Put the contents of this `site` folder at the repository root and push to `main`.
3. In the repository, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`.
4. The site appears at `https://mrsmickers.github.io/rise-motordrome/` within a minute or two.

All paths are relative, so it works from a sub-path. The `.nojekyll` file stops GitHub from running Jekyll over the files.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` / `Space` | Brake (hold at a standstill to reverse) |
| `A` / `D` / `←` / `→` | Steer |
| `Shift` | Boost |
| `V`, `1`–`6` | Cameras: chase, T-cam, cockpit, nose, TV, helicopter |
| `P` | Hot lap autopilot on or off (any pedal or steering input takes over) |
| `R` | Back on track |
| `T` | Time of day: dawn, day, sunset, floodlit night |
| `C` | Reverse: run the lap clockwise (also on the title screen and the toolbar) |
| `N` / `H` / `F` | Sound, HUD (the eye button top right brings it back), full screen |
| Mouse drag / scroll | Look around / zoom |

Gamepads work (right trigger throttle, left trigger brake, left stick steer, Y camera, X hot lap). Phones get an on-screen steering pad and pedals.

## The cars

| Car | Rules | Engine | Mass |
| --- | --- | --- | --- |
| Kigali, Imigongo, Volcano, Kivu | 2026 | 1.6 V6 turbo hybrid, about 1,000 hp, electric power fades above 290 km/h | 800 kg |
| Scream | 2005 | 3.0 V10, 19,000 rpm | 640 kg |
| Heritage | 1967 | 3.0 V8, no wings | 560 kg |

Air density is set for 1,390 m above sea level (about 86% of sea level), which cuts both drag and downforce. The 2026 car runs about 1:43 on the hot lap in either direction. Reverse keeps a separate best lap.

## How the circuit was built

- **Layout:** traced from u/maxx-usa's 2D reconstruction of the 13 October 2026 render (r/RaceTrackDesigns), smoothed, and scaled to 6.0 km. Direction is anticlockwise.
- **Heights:** designed to the published figures: 1,363.5 to 1,415 m above sea level, 196.9 m of climbing a lap, grades up to 15%, a 10.8% drop into Turn 2 and a 14 to 15% climb out of it.
- **Banking:** 12% through Turn 2, easing to 6% then 4% on exit; positive camber in every other corner.
- **Venue:** stands with white membrane roofs, pit building, terraced red-earth paddock with a cone tower, a bridge near the final corner, lakeside hospitality pods with jetties, and Bugesera airport 3.5 km north.

To change the layout or heights, edit `tools/build_track.py` and rerun it; it reads the traced centreline in `tools/ordered.json` and rewrites `js/track-data.js`. It needs `numpy` and `scipy`.

```bash
cd tools && python3 build_track.py
```

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `css/style.css` | Page, HUD and menus |
| `js/main.js` | Start-up, render loop, post-processing (bloom, ambient occlusion, grading), quality scaling |
| `js/track.js`, `js/track-data.js` | Centreline, heights, banking, racing line, kerbs, run-off and walls |
| `js/trackmesh.js` | Asphalt, kerbs, painted run-off, verges, walls, fences, pit lane |
| `js/terrain.js`, `js/water.js` | Hills, lake basin, ground shading, reflective lake |
| `js/scenery.js`, `js/trees.js` | Buildings, lights, boards, vegetation |
| `js/sky.js` | Sky, sun, shadows, fog and the four times of day |
| `js/cars.js`, `js/car-model.js`, `js/vehicle.js` | Car specs, 3D models and physics |
| `js/cameras.js`, `js/input.js`, `js/audio.js`, `js/hud.js` | Cameras, controls, synthesised sound, telemetry |
| `tools/build_track.py`, `tools/ordered.json` | Track generator and the traced centreline it reads |
