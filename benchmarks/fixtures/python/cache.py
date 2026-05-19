from storage.backend import CacheBackend

class CacheService:
    def __init__(self, backend: CacheBackend):
        self.backend = backend

    def fetch_cached_user(self, user_id: str):
        return self.backend.get(user_id)
