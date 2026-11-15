# Vexcel

**Backend** `services/api/app/sponsors/vexcel/routes.py` · **Frontend** `src/components/sponsors/vexcel/`

- `GET /vexcel/ortho/{parcel}.jpg?buffer_m=&collection=&layer=` serves the orthophoto cut around a parcel: the newest
  capture, or a named one. It sits under the 2D plan and the 3D model in the Studio and is the hero image on the landing
  page. `.../meta` gives the capture date, the resolution, and a `frame`: the image's exact ground footprint in metres
  east/north of the point, computed from the XMP `pixel-bbox` (zoom-21 Web Mercator pixels).
- `GET /vexcel/3d/root`, `/3d/site.json` and `/3d/{endpoint}` proxy the 3D city mesh tileset, so the Studio can show
  the real surroundings. Coverage is limited, and a 404 means no mesh at that point.
- The API key stays server-side. Responses are cached on disk under `data/cache/vexcel`.

## Site aerial views (Define › Site, toggle on the aerial)

| Toggle | Endpoint | What the account returned (checked 2026-11-15) |
|---|---|---|
| Top-down | `/ortho/{id}.jpg` | Newest ortho, 7 cm GSD |
| Then · now | `/captures/{id}` + `/ortho/{id}.jpg?collection=&layer=` | **Available.** `ortho/collections` lists every capture over the point. A Los Angeles parcel had 11, from 2019-03 to 2026-07, across `urban` and `urban-r`; a Houston point had 6+ from 2023 to 2026. The slider compares any two. |
| Oblique | `/oblique/{id}/list`, `/oblique/{id}.jpg?dir=` | **Available.** `oriented/collections` lists `oblique-north/east/south/west` for the newest collection; `oriented/extract` (rotation natural) returns the photo. |
| Heights | `/neighbours/{id}?radius_m=` | **Available as measured DSM − DTM.** See below. |

## Neighbour heights

`structure/extract` returns building footprints with type, roof material and shape, but on this account
`maximum-roof-height`, `eave-height` and `number-of-stories-below-eave` were **null for every structure** (21 of 21 near
a Houston site). Heights are therefore measured directly: up to 5 points inside each footprint, 1.5 m in from its edges,
are sent as one `MULTIPOINT` to `dsm/elevation` (surface) and `dtm/elevation` (bare earth). The building height is the
median DSM minus the median DTM, labelled **Measured**. Storeys are estimated at 4 m each. For example, two-storey
apartments in Los Angeles measured 6.2–7.3 m, and 51 of 51 structures within 150 m were measured in about 12 s,
uncached. The Imagery Analyst agent uses the same data.

## Not built

- The 3D mesh (`3d/tileset`) was already in use. Coverage is still limited (in Houston, collection
  `us-tx-houstonr2-2023`, inner loop only).
- `dsm/extract` (a height raster) and `elements/detect` (Vexcel's own zero-shot detection) exist in the API, but the
  footprint and point-elevation approach covered the need.
