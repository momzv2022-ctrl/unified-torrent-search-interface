"""Fixture engine: raises. Exercises failure attribution and the circuit breaker."""


class fixbroken:
    url = "https://fixbroken.test"
    name = "Fixture Broken"
    supported_categories = {"all": ""}

    def search(self, what, cat="all"):
        raise RuntimeError("upstream site returned a challenge page")
