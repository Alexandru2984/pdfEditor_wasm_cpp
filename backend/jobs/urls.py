"""URL routing for the jobs app."""

from django.urls import path
from .views import SavePdfJobView

urlpatterns = [
    path("save-pdf-job/", SavePdfJobView.as_view(), name="save-pdf-job"),
]
