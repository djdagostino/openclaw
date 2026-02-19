#!/usr/bin/env python3
"""
Start the Cognee bridge server.

Prerequisites:
  pip install cognee==0.4.0 fastapi uvicorn pydantic

Environment Variables (set before running):
  OPENAI_API_KEY or COGNEE_LLM_API_KEY: Your OpenAI API key

Usage:
  # Set your API key
  export OPENAI_API_KEY="sk-..."
  # Or on Windows:
  set OPENAI_API_KEY=sk-...

  # Run the server
  python start_server.py
"""
import os
import sys

# Get the API key from environment
api_key = os.environ.get("COGNEE_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")

if not api_key:
    print("ERROR: No API key found.")
    print("Please set OPENAI_API_KEY or COGNEE_LLM_API_KEY environment variable.")
    print("")
    print("Example:")
    print("  export OPENAI_API_KEY='sk-...'")
    print("  python start_server.py")
    sys.exit(1)

# Set both env vars for Cognee
os.environ["COGNEE_LLM_API_KEY"] = api_key
os.environ["OPENAI_API_KEY"] = api_key

# Disable multi-user access control (fixes path issues on Windows)
os.environ["ENABLE_BACKEND_ACCESS_CONTROL"] = "false"

# Start uvicorn
import uvicorn
uvicorn.run("server:app", host="127.0.0.1", port=8000, log_level="info")
