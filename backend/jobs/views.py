"""
API views for the jobs app.

Provides:
  POST /api/save-pdf-job/  — log a PDF processing transaction
  GET  /api/save-pdf-job/  — list all jobs (for debugging/admin)
"""

from django.conf import settings
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ProcessedPDFJob
from .serializers import ProcessedPDFJobSerializer


class SavePdfJobView(APIView):
    """
    POST: Receive PDF processing results from the Wasm frontend and log them.
    GET:  List all jobs (useful for debugging — restrict in production).

    Authentication (PoC):
        The frontend sends an `Authorization: Bearer <token>` header.
        We validate it against settings.API_AUTH_TOKEN.
        In production, replace this with JWT validation or Django session auth.
    """

    permission_classes = [AllowAny]  # Auth is handled manually below

    def _authenticate(self, request):
        """
        Validate the Authorization header.
        Returns (user_identifier, error_response).
        If error_response is not None, return it immediately.
        """
        auth_header = request.headers.get("Authorization", "")

        if not auth_header.startswith("Bearer "):
            return None, Response(
                {"error": "Missing or malformed Authorization header. Expected: Bearer <token>"},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        token = auth_header[len("Bearer "):]
        expected_token = getattr(settings, "API_AUTH_TOKEN", "")

        if token != expected_token:
            return None, Response(
                {"error": "Invalid authorization token."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # For PoC, use the token as user identifier.
        # In production, decode JWT to get the actual user ID/email.
        return f"token-user:{token[:8]}...", None

    def post(self, request):
        """Log a PDF processing job."""
        user_id, error = self._authenticate(request)
        if error:
            return error

        serializer = ProcessedPDFJobSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {"error": "Validation failed.", "details": serializer.errors},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Truncate text_preview to 500 chars server-side (defense in depth)
        text_preview = serializer.validated_data.get("text_preview", "")
        if len(text_preview) > 500:
            serializer.validated_data["text_preview"] = text_preview[:500]

        serializer.save(user_identifier=user_id)

        return Response(
            {"message": "Job saved successfully.", "job": serializer.data},
            status=status.HTTP_201_CREATED,
        )

    def get(self, request):
        """List all jobs (for debugging)."""
        user_id, error = self._authenticate(request)
        if error:
            return error

        jobs = ProcessedPDFJob.objects.all()[:50]
        serializer = ProcessedPDFJobSerializer(jobs, many=True)
        return Response({"count": len(serializer.data), "jobs": serializer.data})
