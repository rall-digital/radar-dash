# Third-party licences

The cards in `dist/` are MIT licensed (see `../LICENSE`). They ship with:

| what | files | licence |
|---|---|---|
| Leaflet 1.9.4 | `dist/leaflet.js`, `dist/leaflet.css` (unmodified) | BSD 2-Clause: `Leaflet-BSD-2-Clause.txt` |
| Figtree (variable, Latin subset) | `dist/fonts/figtree-latin-wght-normal.woff2` | SIL Open Font License 1.1: `OFL-figtree.txt` |
| Fredoka (variable, Latin subset) | `dist/fonts/fredoka-latin-wght-normal.woff2` | SIL Open Font License 1.1: `OFL-fredoka.txt` |
| Material Design Icons 7.4.47 (`mdi:microsoft-xbox` path) | inside `dist/wall-horizon-card.js` (`XBOX_PATH`) | Apache 2.0: `MaterialDesignIcons-Apache-2.0.txt`. The Xbox logo itself is a Microsoft trademark. |

The two font licence texts are also next to the fonts in `dist/fonts/`, so they travel with any copy of that folder.
The colour tables inside `wall-radar-card.js` are data: IEM's n0q colormap, MetPy's NWS reflectivity table and
RainViewer's published colour tables.
