"""Test double for `nova2`: plugins are allowed to import it."""

from abc import ABC, abstractmethod


class Engine(ABC):
    name: str
    url: str
    supported_categories: dict

    @abstractmethod
    def search(self, query: str, category: str = "all") -> None: ...
