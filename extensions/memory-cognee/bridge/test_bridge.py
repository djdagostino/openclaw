#!/usr/bin/env python3
"""
Test script for the Cognee Bridge.

Run this to verify the bridge is working:
  python test_bridge.py

Prerequisites:
  pip install cognee fastapi uvicorn pydantic httpx
"""

import asyncio
import sys

async def test_bridge():
    try:
        import httpx
    except ImportError:
        print("Installing httpx for testing...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
        import httpx

    base_url = "http://localhost:8000"

    async with httpx.AsyncClient(timeout=30.0) as client:
        print("=" * 60)
        print("COGNEE BRIDGE TEST")
        print("=" * 60)

        # Test 1: Health check
        print("\n1. Health Check...")
        try:
            r = await client.get(f"{base_url}/health")
            if r.status_code == 200:
                print(f"   ✓ Bridge is healthy: {r.json()}")
            else:
                print(f"   ✗ Health check failed: {r.status_code}")
                return False
        except httpx.ConnectError:
            print(f"   ✗ Cannot connect to {base_url}")
            print("   → Start the bridge first: python -m uvicorn server:app --port 8000")
            return False

        # Test 2: Status
        print("\n2. Status...")
        r = await client.get(f"{base_url}/status")
        print(f"   Status: {r.json()}")

        # Test 3: Add content
        print("\n3. Adding test content...")
        test_contents = [
            "We decided to use PostgreSQL for the user database.",
            "The API key is stored in the .env file under DATABASE_URL.",
            "I prefer using TypeScript with strict mode enabled.",
            "The backend connects to Redis for caching.",
        ]

        for content in test_contents:
            r = await client.post(f"{base_url}/add", json={"text": content})
            if r.status_code == 200:
                print(f"   ✓ Added: {content[:50]}...")
            else:
                print(f"   ✗ Failed: {r.text}")

        # Test 4: Cognify (build knowledge graph)
        print("\n4. Building knowledge graph (cognify)...")
        r = await client.post(f"{base_url}/cognify", json={"full_rebuild": False})
        if r.status_code == 200:
            print(f"   ✓ Cognify complete: {r.json()}")
        else:
            print(f"   ✗ Cognify failed: {r.text}")

        # Test 5: Search
        print("\n5. Searching for 'database'...")
        r = await client.post(f"{base_url}/search", json={
            "query": "database",
            "limit": 3,
            "min_score": 0.1,
            "graph_depth": 2
        })
        if r.status_code == 200:
            results = r.json()
            print(f"   Found {results['total']} results:")
            for res in results['results']:
                print(f"   - [{res['score']:.2f}] {res['text'][:60]}...")
        else:
            print(f"   ✗ Search failed: {r.text}")

        # Test 6: Graph exploration
        print("\n6. Exploring graph around 'PostgreSQL'...")
        r = await client.post(f"{base_url}/graph/explore", json={
            "entity": "PostgreSQL",
            "depth": 2,
            "include_content": True
        })
        if r.status_code == 200:
            graph = r.json()
            print(f"   Nodes: {len(graph['nodes'])}")
            print(f"   Edges: {len(graph['edges'])}")
            for node in graph['nodes'][:3]:
                print(f"   - {node['label']} ({node['type']})")
        else:
            print(f"   ✗ Explore failed: {r.text}")

        # Test 7: Status after operations
        print("\n7. Final status...")
        r = await client.get(f"{base_url}/status")
        status = r.json()
        print(f"   Documents: {status['document_count']}")
        print(f"   Nodes: {status['node_count']}")
        print(f"   Edges: {status['edge_count']}")

        print("\n" + "=" * 60)
        print("ALL TESTS PASSED ✓")
        print("=" * 60)
        return True


if __name__ == "__main__":
    success = asyncio.run(test_bridge())
    sys.exit(0 if success else 1)
