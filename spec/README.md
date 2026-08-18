# spec/

`tsp-openapi.yaml` is a copy of [`openapi.yaml`][upstream] from
raul2hot/torrent-stream-protocol — the contract this service implements.

It is checked in so `tests/test_conformance.py` can validate real responses
against it without a network call, which keeps CI honest and offline. The
`spec-drift` job in `.github/workflows/ci.yml` re-downloads the upstream file on
every run and fails if this copy has fallen behind, so the two cannot silently
diverge.

To refresh it by hand:

```sh
curl -o spec/tsp-openapi.yaml \
  https://raw.githubusercontent.com/raul2hot/torrent-stream-protocol/main/openapi.yaml
```

[upstream]: https://github.com/raul2hot/torrent-stream-protocol/blob/main/openapi.yaml
