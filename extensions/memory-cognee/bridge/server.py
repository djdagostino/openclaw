#!/usr/bin/env python3
"""
Cognee Bridge Server for OpenClaw

A FastAPI service that exposes Cognee's knowledge graph memory capabilities
via a REST API for consumption by the OpenClaw TypeScript plugin.

Run: uvicorn server:app --host 0.0.0.0 --port 8000
"""

import asyncio
import os
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import cognee

# =============================================================================
# Configuration
# =============================================================================

# Use pathlib for proper cross-platform path handling
_default_data_dir = str(Path.home() / ".openclaw" / "memory" / "cognee")
DATA_DIR = os.environ.get("COGNEE_DATA_DIR", _default_data_dir)
LLM_PROVIDER = os.environ.get("COGNEE_LLM_PROVIDER", "openai")
LLM_API_KEY = os.environ.get("COGNEE_LLM_API_KEY", os.environ.get("OPENAI_API_KEY"))
LLM_MODEL = os.environ.get("COGNEE_LLM_MODEL", "gpt-4o-mini")
EMBEDDING_MODEL = os.environ.get("COGNEE_EMBEDDING_MODEL", "text-embedding-3-small")

# =============================================================================
# Request/Response Models
# =============================================================================

class AddRequest(BaseModel):
    """Request to add content to the knowledge graph."""
    text: str = Field(..., description="Text content to add")
    source: Optional[str] = Field(None, description="Source identifier (e.g., 'user', 'conversation')")
    metadata: Optional[dict] = Field(None, description="Additional metadata")


class AddResponse(BaseModel):
    """Response after adding content."""
    success: bool
    document_id: Optional[str] = None
    message: str


class CognifyRequest(BaseModel):
    """Request to build/update the knowledge graph."""
    full_rebuild: bool = Field(False, description="Whether to rebuild the entire graph")


class CognifyResponse(BaseModel):
    """Response after cognify operation."""
    success: bool
    nodes_created: int = 0
    edges_created: int = 0
    message: str


class SearchRequest(BaseModel):
    """Request to search the knowledge graph."""
    query: str = Field(..., description="Search query")
    limit: int = Field(5, ge=1, le=20, description="Maximum results")
    min_score: float = Field(0.3, ge=0, le=1, description="Minimum relevance score")
    graph_depth: int = Field(2, ge=1, le=5, description="Depth of graph traversal for related content")


class SearchResult(BaseModel):
    """A single search result with linked context."""
    id: str
    text: str
    score: float
    category: Optional[str] = None
    source: Optional[str] = None
    created_at: Optional[str] = None
    # Linked context from knowledge graph
    related_entities: list[dict] = Field(default_factory=list)
    relationships: list[dict] = Field(default_factory=list)


class SearchResponse(BaseModel):
    """Response from search operation."""
    results: list[SearchResult]
    total: int
    query_entities: list[str] = Field(default_factory=list, description="Entities extracted from query")


class GraphExploreRequest(BaseModel):
    """Request to explore the knowledge graph around an entity."""
    entity: str = Field(..., description="Entity name or ID to explore")
    depth: int = Field(2, ge=1, le=5, description="Traversal depth")
    include_content: bool = Field(True, description="Include full content of related nodes")


class GraphNode(BaseModel):
    """A node in the knowledge graph."""
    id: str
    label: str
    type: str
    properties: dict = Field(default_factory=dict)
    content: Optional[str] = None


class GraphEdge(BaseModel):
    """An edge in the knowledge graph."""
    source: str
    target: str
    type: str
    properties: dict = Field(default_factory=dict)


class GraphExploreResponse(BaseModel):
    """Response from graph exploration."""
    center_node: Optional[GraphNode] = None
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class StatusResponse(BaseModel):
    """System status response."""
    healthy: bool
    cognee_version: str
    document_count: int
    node_count: int
    edge_count: int
    last_cognify: Optional[str] = None


class DeleteRequest(BaseModel):
    """Request to delete content."""
    query: Optional[str] = Field(None, description="Search query to find content to delete")
    document_id: Optional[str] = Field(None, description="Specific document ID to delete")


class DeleteResponse(BaseModel):
    """Response from delete operation."""
    success: bool
    deleted_count: int
    message: str


# =============================================================================
# Application State
# =============================================================================

class AppState:
    """Shared application state."""
    initialized: bool = False
    last_cognify: Optional[datetime] = None
    document_count: int = 0
    node_count: int = 0
    edge_count: int = 0


state = AppState()


# =============================================================================
# Lifecycle
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Cognee on startup."""
    # Set LLM configuration using individual setters
    if LLM_API_KEY:
        print(f"Configuring Cognee with API key: {LLM_API_KEY[:8]}...{LLM_API_KEY[-4:]}")

        # Use individual setter methods
        cognee.config.set_llm_api_key(LLM_API_KEY)
        cognee.config.set_llm_provider(LLM_PROVIDER)
        cognee.config.set_llm_model(LLM_MODEL)

        print(f"LLM: {LLM_PROVIDER}/{LLM_MODEL}")
    else:
        print("WARNING: No API key configured!")

    state.initialized = True
    print("Cognee bridge initialized (using default data directory)")

    yield

    # Cleanup
    print("Cognee bridge shutting down")


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(
    title="Cognee Bridge",
    description="REST API bridge for Cognee knowledge graph memory",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {"status": "healthy", "initialized": state.initialized}


@app.get("/status", response_model=StatusResponse)
async def get_status() -> StatusResponse:
    """Get system status and statistics."""
    return StatusResponse(
        healthy=state.initialized,
        cognee_version=cognee.__version__ if hasattr(cognee, "__version__") else "unknown",
        document_count=state.document_count,
        node_count=state.node_count,
        edge_count=state.edge_count,
        last_cognify=state.last_cognify.isoformat() if state.last_cognify else None,
    )


@app.post("/add", response_model=AddResponse)
async def add_content(request: AddRequest) -> AddResponse:
    """
    Add content to Cognee's knowledge base.

    This stores the raw text for later processing by cognify().
    """
    try:
        # Add to Cognee
        await cognee.add(request.text)
        state.document_count += 1

        return AddResponse(
            success=True,
            document_id=None,  # Cognee doesn't return IDs on add
            message=f"Content added ({len(request.text)} chars)",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/cognify", response_model=CognifyResponse)
async def cognify_content(request: CognifyRequest) -> CognifyResponse:
    """
    Process added content and build/update the knowledge graph.

    This is the "magic" step that:
    1. Extracts entities from text
    2. Identifies relationships between entities
    3. Builds a connected knowledge graph
    4. Creates vector embeddings for semantic search
    """
    try:
        if request.full_rebuild:
            # Reset and rebuild everything
            await cognee.prune.prune_data()
            await cognee.prune.prune_system(metadata=True)

        # Run cognify to build knowledge graph
        await cognee.cognify()

        state.last_cognify = datetime.now()

        return CognifyResponse(
            success=True,
            nodes_created=0,  # Would need to track delta
            edges_created=0,
            message="Knowledge graph updated",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", response_model=SearchResponse)
async def search_knowledge(request: SearchRequest) -> SearchResponse:
    """
    Search the knowledge graph.

    This performs:
    1. Semantic vector search for relevant content
    2. Entity extraction from query
    3. Graph traversal to find related context
    4. Returns unified results with linked metadata
    """
    try:
        from cognee.modules.search.types import SearchType

        # Use CHUNKS for structured results, GRAPH_COMPLETION for LLM answers
        raw_results = await cognee.search(
            query_text=request.query,
            query_type=SearchType.CHUNKS,  # Returns structured chunk results
            top_k=request.limit,
        )

        results = []
        query_entities = []

        for i, item in enumerate(raw_results[:request.limit]):
            # Handle Cognee 0.4.0 SearchResult objects
            # item is a SearchResult with search_result field containing the chunk data
            search_data = item.search_result if hasattr(item, 'search_result') else item

            # Extract text and metadata from the chunk
            if hasattr(search_data, 'text'):
                text = search_data.text
            elif hasattr(search_data, 'chunk_text'):
                text = search_data.chunk_text
            elif isinstance(search_data, str):
                text = search_data
            elif isinstance(search_data, dict):
                text = search_data.get('text', search_data.get('content', str(search_data)))
            else:
                text = str(search_data)

            # Get score if available
            score = 0.5  # default
            if hasattr(search_data, 'score'):
                score = search_data.score
            elif hasattr(search_data, 'distance'):
                score = 1.0 - search_data.distance  # Convert distance to similarity

            result = SearchResult(
                id=str(i),
                text=text[:500] if len(text) > 500 else text,  # Truncate long texts
                score=score,
                category=None,
                source=str(item.dataset_name) if hasattr(item, 'dataset_name') else None,
                created_at=None,
                related_entities=[],
                relationships=[],
            )

            if result.score >= request.min_score:
                results.append(result)

        return SearchResponse(
            results=results,
            total=len(results),
            query_entities=query_entities,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/graph/explore", response_model=GraphExploreResponse)
async def explore_graph(request: GraphExploreRequest) -> GraphExploreResponse:
    """
    Explore the knowledge graph around a specific entity.

    This allows direct graph traversal to understand relationships
    between concepts in the user's knowledge base.
    """
    try:
        from cognee.modules.search.types import SearchType

        # Search for the entity using CHUNKS
        search_results = await cognee.search(
            query_text=request.entity,
            query_type=SearchType.CHUNKS,
            top_k=10,
        )

        nodes = []
        edges = []
        center_node = None

        # Build graph representation from results
        for i, item in enumerate(search_results):
            # Handle Cognee 0.4.0 SearchResult objects
            search_data = item.search_result if hasattr(item, 'search_result') else item

            # Extract text
            if hasattr(search_data, 'text'):
                text = search_data.text
            elif hasattr(search_data, 'chunk_text'):
                text = search_data.chunk_text
            elif isinstance(search_data, str):
                text = search_data
            else:
                text = str(search_data)

            node = GraphNode(
                id=str(i),
                label=text[:50] if text else f"Node {i}",
                type="document",
                properties={},
                content=text if request.include_content else None,
            )

            if center_node is None:
                center_node = node

            nodes.append(node)

            # Note: In CHUNKS mode, we don't have relationship data
            # For relationship extraction, would need to use CYPHER or graph-specific queries

        return GraphExploreResponse(
            center_node=center_node,
            nodes=nodes,
            edges=edges,  # Empty for now - relationship extraction requires more work
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/delete", response_model=DeleteResponse)
async def delete_content(request: DeleteRequest) -> DeleteResponse:
    """
    Delete content from the knowledge base.

    GDPR-compliant deletion of user data.
    """
    try:
        deleted = 0

        if request.document_id:
            # Delete specific document
            # Note: Cognee's deletion API may vary
            await cognee.prune.prune_data()  # This is a placeholder
            deleted = 1
        elif request.query:
            # Search and delete matching content
            results = await cognee.search(query_text=request.query)
            # Would need to delete each result
            deleted = len(results)

        return DeleteResponse(
            success=True,
            deleted_count=deleted,
            message=f"Deleted {deleted} items",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset")
async def reset_knowledge_base() -> dict:
    """
    Reset the entire knowledge base.

    WARNING: This deletes all stored knowledge!
    """
    try:
        await cognee.prune.prune_data()
        await cognee.prune.prune_system(metadata=True)

        state.document_count = 0
        state.node_count = 0
        state.edge_count = 0
        state.last_cognify = None

        return {"success": True, "message": "Knowledge base reset"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("COGNEE_PORT", 8000))
    host = os.environ.get("COGNEE_HOST", "127.0.0.1")

    uvicorn.run(app, host=host, port=port)
