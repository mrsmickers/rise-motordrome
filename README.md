# African Grand Prix

Version 0.13 beta.

A browser sim of the planned African Grand Prix circuit in Bugesera, Rwanda (interim name RISE Motordrome), built with three.js (WebGPU, with a WebGL 2 fallback). You drive or ride along in an F1 car on a 6 km, 17-turn lap with 197 m of climbing, beside a lake.

The 2026 car is a 3D model, ["2026 Redbull RB22"](https://sketchfab.com/3d-models/2026-redbull-rb22-0a3d24a58e0549d591a5a48c22eec383) by [Tyler_Dave](https://sketchfab.com/Tyler_Dave), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with its livery and branding removed and repainted at load time (see `models/CREDITS.md`). Everything else is generated in code: the terrain, track, stands, trees, the 2005 and 1967 cars and all the sound. The other downloads are three.js from jsDelivr and two Google Fonts.

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
| `V`, `1`–`6` | Cameras: chase (the default), T-cam, cockpit, nose, TV, helicopter |
| `P` | Hot lap autopilot on or off (any pedal or steering input takes over). "Ride a hot lap" starts from pole: title card, then the gantry's five red lights turn green |
| `R` | Back on track |
| `T` | Time of day: dawn, day, sunset, floodlit night |
| `C` | Reverse: run the lap clockwise (also on the title screen and the toolbar) |
| `L` | Assist level: Beginner, Intermediate, Advanced (also on the title screen and the toolbar) |
| `N` / `H` / `F` | Sound, HUD (the eye button top right brings it back), full screen |
| `Esc` | Back to the menu (also the Menu button, top left) |
| Mouse drag / scroll | Look around / zoom |

Gamepads may work (right trigger throttle, left trigger brake, left stick steer, Y camera, X hot lap) but are untested. Phones get an on-screen steering pad and pedals.

## Assists

| Level | What helps |
| --- | --- |
| Beginner (default) | Chevrons along the racing line; steering follows the line and your steering moves you up to 3 m either side of it; braking help; traction control; auto recovery |
| Intermediate | Chevrons in the braking zones only; traction control; a nudge back at the track edge; auto recovery |
| Advanced | Nothing |

Chevrons go yellow where you should lift and red from the point where you need to brake, worked out from your speed each frame. The choice is remembered in the browser.

## The cars

| Car | Rules | Engine | Mass |
| --- | --- | --- | --- |
| Kigali, Imigongo, Volcano, Kivu | 2026 | 1.6 V6 turbo hybrid, about 1,000 hp, electric power fades above 290 km/h | 800 kg |
| Scream | 2005 | 3.0 V10, 19,000 rpm | 640 kg |
| Heritage | 1967 | 3.0 V8, no wings | 560 kg |

The cars, two bridges, the pit roof, the walls on both sides of the start/finish straight and in every heavy braking zone (Turns 1, 3, 4, 8, 12, 14 and 17), and raised billboards past Turns 3, 8, 12 and 17 carry Ingenio Technologies branding. Add `?assurix` to the address (`?brand=assurix` and `?=assurix` work too) to show Assurix instead.

Air density is set for 1,390 m above sea level (about 86% of sea level), which cuts both drag and downforce. The 2026 car runs about 1:40 on the hot lap in either direction. Reverse keeps a separate best lap.

## How the circuit was built

- **Layout:** traced from u/maxx-usa's 2D reconstruction of the 13 October 2026 render (r/RaceTrackDesigns) and scaled to 6.0 km, anticlockwise. The esses are taken from the official Tilke / Dar / WurzDesign layout render: a camera fitted to its magenta line (3.7 px average error) projects it onto the ground.
- **Heights:** designed to what Alex Wurz and Carsten Tilke have said: 1,363.5 to 1,415 m above sea level, 196 m of climbing a lap, grades up to 15%, a 10.8% drop into Turn 2 and a 14 to 15% climb out of it, a back straight that drops, compresses and climbs at about 12.5%, a crest off the canopy corner into a 10% compression, and a hill into the double right with the compression at the apex.
- **Banking:** 12% through Turn 2, easing to 6% then 4% on exit; over 12% at the top hairpin and the forest corner; positive camber everywhere, no off-camber corners.
- **Venue:** stands with white membrane roofs, pit building, terraced red-earth paddock with a cone tower, two spectator hills, bridges near the final corner and on the crest before Turn 8, lakeside hospitality pods with jetties, papyrus islands on the lake, villages in dry red-earth farmland, and Bugesera airport 3.5 km north.

To change the layout or heights, edit `tools/build_track.py` and rerun it. It reads `tools/base_centreline.json` (the traced lap) and `tools/official_esses.json` (the stretch from the official render) and rewrites `js/track-data.js`. It needs `numpy` and `scipy`.

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
| `js/assists.js`, `js/chevrons.js` | Assist levels and the racing-line chevrons |
| `models/rb22.glb`, `models/CREDITS.md` | The 2026 car model, its licence and the changes made |
| `js/brand.js`, `brand/`, `tools/build_brand.py` | Sponsor colours and textures; the script rebuilds `brand/ingenio/` and `brand/assurix/` from the logos in `brand/src/` (needs Pillow) |
| `tools/build_track.py`, `tools/base_centreline.json`, `tools/official_esses.json` | Track generator and the lines it reads |
