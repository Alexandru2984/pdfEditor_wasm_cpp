"""DRF serializer for ProcessedPDFJob."""

from rest_framework import serializers
from .models import ProcessedPDFJob


class ProcessedPDFJobSerializer(serializers.ModelSerializer):
    """
    Serializer for creating and reading ProcessedPDFJob records.

    The frontend POSTs JSON with PDF metadata + operation results.
    user_identifier is set automatically by the view (from auth header).
    """

    class Meta:
        model = ProcessedPDFJob
        fields = [
            "id",
            "user_identifier",
            "filename",
            "file_size",
            "pdf_version",
            "page_count",
            "operation_type",
            "text_preview",
            "status",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "user_identifier", "created_at", "updated_at"]
