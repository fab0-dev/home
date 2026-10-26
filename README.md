# fab0 home

The public home of fab0: the published JSON Schema of a pipeline, served at `https://schema.fab0.dev/`, and the recipe library of tested pipelines.

- `schema/`: `pipeline.v1.json` and `_headers`, the output directory Cloudflare Pages serves.
- `recipes/`: pipeline documents for `.fab0/pipelines.yml`, starting with `feature-delivery`.

Both are authored and tested in `fab0-dev/fab0` and copied here by its release workflow, as a pull request from `fab0-release[bot]` that a person reviews. Don't edit them by hand.
