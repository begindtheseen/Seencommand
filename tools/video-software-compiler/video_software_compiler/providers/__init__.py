"""Acquisition providers. Providers never bypass source access controls."""

from video_software_compiler.providers.local import LocalIngestionProvider

__all__ = ["LocalIngestionProvider"]
