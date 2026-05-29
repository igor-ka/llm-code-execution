# The EXECUTION image: minimal, non-root environment that AI-generated code runs in.
# Kept intentionally small and dependency-light. This same OCI image is what would run
# under Cloud Run Jobs / GKE+gVisor in the GCP future — only the launch mechanism changes.
FROM python:3.12-slim

# A handful of common, pure-ish libraries so generated code is useful out of the box.
# Add cautiously: every package is attack surface inside the sandbox.
RUN pip install --no-cache-dir numpy==2.1.3

# Non-root user; the backend also enforces user="1000:1000" at run time.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin sandboxuser

WORKDIR /sandbox
USER 1000:1000

# No ENTRYPOINT/CMD that runs code: the backend supplies the command per execution.
CMD ["python", "--version"]
