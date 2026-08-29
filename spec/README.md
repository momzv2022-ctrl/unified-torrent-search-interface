# spec/

`tsp-openapi.yaml` is a copy of the Torrent Stream Protocol `openapi.yaml`,
the contract this service implements.

It is checked in so `tests/test_conformance.py` can validate real responses
against it without a network call, which keeps CI honest and offline. As far as
this repo is concerned, the checked-in copy is the contract.

The `spec-drift` job in `.github/workflows/ci.yml` can also compare this copy
against the upstream file on every run, so the two cannot silently diverge. That
check stays off until the repository variable `TSP_SPEC_URL` is set to the URL of
the upstream file.

To refresh the copy by hand:

```sh
curl -o spec/tsp-openapi.yaml "$TSP_SPEC_URL"
```
