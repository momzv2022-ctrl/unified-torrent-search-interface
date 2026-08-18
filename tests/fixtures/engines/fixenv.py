"""Fixture engine: prints its environment so the scrubbing test can assert on it."""

import json
import os


class fixenv:
    url = "https://fixenv.test"
    name = "Fixture Env"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        print("ENV " + json.dumps(dict(os.environ)))
        print("ARGV " + json.dumps(__import__("sys").argv))
        print("WHAT " + what)
