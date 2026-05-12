"""Admin registration for ProcessedPDFJob."""

from django.contrib import admin
from .models import ProcessedPDFJob


@admin.register(ProcessedPDFJob)
class ProcessedPDFJobAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "filename",
        "operation_type",
        "status",
        "page_count",
        "file_size",
        "user_identifier",
        "created_at",
    ]
    list_filter = ["status", "operation_type", "created_at"]
    search_fields = ["filename", "user_identifier"]
    readonly_fields = ["created_at", "updated_at"]
    ordering = ["-created_at"]
