"""
ProcessedPDFJob model — logs each PDF processing transaction.

Stores metadata about the operation performed by the Wasm frontend,
NOT the file itself (the file never leaves the browser).
"""

from django.db import models


class ProcessedPDFJob(models.Model):
    """A record of a PDF processing operation performed in the browser."""

    class OperationType(models.TextChoices):
        METADATA_ANALYSIS = "metadata_analysis", "Metadata Analysis"
        TEXT_EXTRACTION = "text_extraction", "Text Extraction"
        PAGE_RENDER = "page_render", "Page Render"
        FULL_ANALYSIS = "full_analysis", "Full Analysis"

    class Status(models.TextChoices):
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"

    # Who performed the operation (JWT sub, session ID, or IP)
    user_identifier = models.CharField(
        max_length=255,
        help_text="Identifier of the user or client (JWT sub, session ID, IP).",
    )

    # PDF metadata (sent by the frontend, NOT the actual file)
    filename = models.CharField(max_length=512)
    file_size = models.PositiveIntegerField(help_text="File size in bytes.")
    pdf_version = models.CharField(max_length=10, blank=True, default="")
    page_count = models.PositiveIntegerField(default=0)

    # What operation was performed
    operation_type = models.CharField(
        max_length=30,
        choices=OperationType.choices,
        default=OperationType.FULL_ANALYSIS,
    )

    # Preview of extracted text (first 500 chars — not the full text)
    text_preview = models.TextField(
        blank=True,
        default="",
        help_text="First 500 characters of extracted text.",
    )

    # Result status
    status = models.CharField(
        max_length=10,
        choices=Status.choices,
        default=Status.COMPLETED,
    )

    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Processed PDF Job"
        verbose_name_plural = "Processed PDF Jobs"

    def __str__(self):
        return f"[{self.status}] {self.filename} ({self.operation_type}) — {self.created_at:%Y-%m-%d %H:%M}"
