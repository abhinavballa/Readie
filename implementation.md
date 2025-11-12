# Chrome Extension + Python Backend - Implementation Guide

## Architecture Overview

```
Chrome Extension (Frontend)
    ↓
Python FastAPI Backend (Your Server)
    ↓
├── LLM APIs (OpenAI/Anthropic)
├── Vector Database (ChromaDB) - Ready for RAG
└── PostgreSQL (User data, history)
```

---

## PART A: Backend Setup

---

## STEP 1: Backend Project Structure (10 min)

### Create Backend Folder
```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app
│   ├── config.py            # Configuration
│   ├── models.py            # Database models
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── query.py         # Query endpoints
│   │   └── auth.py          # Auth endpoints
│   ├── services/
│   │   ├── __init__.py
│   │   ├── llm_service.py   # LLM integration
│   │   └── rag_service.py   # RAG (future)
│   └── db/
│       ├── __init__.py
│       └── database.py      # Database connection
├── requirements.txt
├── .env.example
└── README.md
```

### requirements.txt
```txt
fastapi==0.104.1
uvicorn[standard]==0.24.0
python-dotenv==1.0.0
anthropic==0.7.0
openai==1.3.0
sqlalchemy==2.0.23
psycopg2-binary==2.9.9
chromadb==0.4.18
pydantic==2.5.0
python-multipart==0.0.6
pyjwt==2.8.0
bcrypt==4.1.1
pillow==10.1.0
```

### .env.example
```bash
# Server
PORT=8000
HOST=0.0.0.0
ENVIRONMENT=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/screen_query_db

# API Keys (stored server-side)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# JWT
JWT_SECRET=your-secret-key-here
JWT_ALGORITHM=HS256
JWT_EXPIRATION_HOURS=24

# Vector DB (for future RAG)
CHROMA_PERSIST_DIR=./chroma_db

# CORS
ALLOWED_ORIGINS=chrome-extension://your-extension-id
```

---

## STEP 2: Backend Core Setup (20 min)

### app/config.py
```python
from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    # Server
    port: int = 8000
    host: str = "0.0.0.0"
    environment: str = "development"
    
    # Database
    database_url: str
    
    # API Keys
    openai_api_key: str
    anthropic_api_key: str
    
    # JWT
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24
    
    # Vector DB
    chroma_persist_dir: str = "./chroma_db"
    
    # CORS
    allowed_origins: str
    
    class Config:
        env_file = ".env"

@lru_cache()
def get_settings():
    return Settings()
```

### app/main.py
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.routes import query, auth

settings = get_settings()

app = FastAPI(
    title="Screen Query AI Backend",
    version="1.0.0",
    description="Backend for Chrome extension with RAG support"
)

# CORS - Allow Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(query.router, prefix="/api", tags=["query"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

@app.get("/")
async def root():
    return {"status": "ok", "message": "Screen Query AI Backend"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.environment == "development"
    )
```

---

## STEP 3: Database Models (15 min)

### app/db/database.py
```python
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.config import get_settings

settings = get_settings()

engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

### app/models.py
```python
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.database import Base

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # API keys stored per user (encrypted)
    openai_key = Column(String, nullable=True)
    anthropic_key = Column(String, nullable=True)
    
    # Relations
    queries = relationship("Query", back_populates="user")
    documents = relationship("Document", back_populates="user")

class Query(Base):
    __tablename__ = "queries"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    
    # Query data
    question = Column(Text)
    answer = Column(Text)
    image_data = Column(Text)  # base64 or URL to stored image
    
    # Metadata
    llm_provider = Column(String)  # "openai" or "anthropic"
    model_used = Column(String)
    tokens_used = Column(Integer)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relations
    user = relationship("User", back_populates="queries")

class Document(Base):
    """For future RAG implementation"""
    __tablename__ = "documents"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    
    # Document info
    title = Column(String)
    source_url = Column(String, nullable=True)
    content_hash = Column(String, unique=True)  # Hash of content
    
    # RAG metadata
    is_embedded = Column(Boolean, default=False)
    embedding_model = Column(String, nullable=True)
    chunk_count = Column(Integer, default=0)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relations
    user = relationship("User", back_populates="documents")
```

---

## STEP 4: LLM Service (30 min)

### app/services/llm_service.py
```python
import openai
import anthropic
from typing import Optional
from app.config import get_settings

settings = get_settings()

class LLMService:
    def __init__(self):
        # Use server-side API keys by default
        self.openai_client = openai.OpenAI(api_key=settings.openai_api_key)
        self.anthropic_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    
    async def query_openai(
        self,
        question: str,
        image_base64: str,
        user_api_key: Optional[str] = None
    ) -> dict:
        """Query OpenAI GPT-4 Vision"""
        try:
            # Use user's API key if provided, otherwise use server key
            client = openai.OpenAI(api_key=user_api_key) if user_api_key else self.openai_client
            
            response = client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{image_base64}"
                                }
                            },
                            {
                                "type": "text",
                                "text": question
                            }
                        ]
                    }
                ],
                max_tokens=500
            )
            
            return {
                "answer": response.choices[0].message.content,
                "model": response.model,
                "tokens_used": response.usage.total_tokens
            }
            
        except Exception as e:
            raise Exception(f"OpenAI API error: {str(e)}")
    
    async def query_anthropic(
        self,
        question: str,
        image_base64: str,
        user_api_key: Optional[str] = None
    ) -> dict:
        """Query Anthropic Claude with Vision"""
        try:
            # Use user's API key if provided, otherwise use server key
            client = anthropic.Anthropic(api_key=user_api_key) if user_api_key else self.anthropic_client
            
            message = client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=500,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": image_base64
                                }
                            },
                            {
                                "type": "text",
                                "text": question
                            }
                        ]
                    }
                ]
            )
            
            return {
                "answer": message.content[0].text,
                "model": message.model,
                "tokens_used": message.usage.input_tokens + message.usage.output_tokens
            }
            
        except Exception as e:
            raise Exception(f"Anthropic API error: {str(e)}")
    
    async def query(
        self,
        provider: str,
        question: str,
        image_base64: str,
        user_api_key: Optional[str] = None
    ) -> dict:
        """Main query method"""
        if provider == "openai":
            return await self.query_openai(question, image_base64, user_api_key)
        elif provider == "anthropic":
            return await self.query_anthropic(question, image_base64, user_api_key)
        else:
            raise ValueError(f"Unsupported provider: {provider}")
```

---

## STEP 5: RAG Service Placeholder (10 min)

### app/services/rag_service.py
```python
import chromadb
from typing import List, Optional
from app.config import get_settings

settings = get_settings()

class RAGService:
    """RAG service - ready for future implementation"""
    
    def __init__(self):
        # Initialize ChromaDB
        self.client = chromadb.PersistentClient(path=settings.chroma_persist_dir)
        self.collection = None
    
    def initialize_collection(self, user_id: int):
        """Initialize or get collection for user"""
        collection_name = f"user_{user_id}_documents"
        self.collection = self.client.get_or_create_collection(
            name=collection_name,
            metadata={"user_id": user_id}
        )
        return self.collection
    
    async def add_document(
        self,
        user_id: int,
        document_id: str,
        text_chunks: List[str],
        metadatas: List[dict]
    ):
        """Add document chunks to vector store - For future use"""
        collection = self.initialize_collection(user_id)
        
        # Generate IDs for chunks
        ids = [f"{document_id}_chunk_{i}" for i in range(len(text_chunks))]
        
        # Add to collection
        collection.add(
            documents=text_chunks,
            metadatas=metadatas,
            ids=ids
        )
    
    async def search(
        self,
        user_id: int,
        query: str,
        n_results: int = 3
    ) -> List[dict]:
        """Search for relevant chunks - For future use"""
        collection = self.initialize_collection(user_id)
        
        results = collection.query(
            query_texts=[query],
            n_results=n_results
        )
        
        return results
    
    async def delete_document(self, user_id: int, document_id: str):
        """Delete document from vector store - For future use"""
        collection = self.initialize_collection(user_id)
        
        # Delete all chunks of this document
        collection.delete(where={"document_id": document_id})

# Note: This is a placeholder. Full RAG implementation comes in Phase 2
```

---

## STEP 6: API Routes - Query Endpoint (25 min)

### app/routes/query.py
```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.services.llm_service import LLMService
from app.models import Query, User
from typing import Optional

router = APIRouter()
llm_service = LLMService()

class QueryRequest(BaseModel):
    question: str
    image_data: str  # base64 encoded
    provider: str = "openai"  # "openai" or "anthropic"
    user_id: Optional[int] = None  # Optional: for user-specific features

class QueryResponse(BaseModel):
    answer: str
    model: str
    tokens_used: int

@router.post("/query", response_model=QueryResponse)
async def create_query(
    request: QueryRequest,
    db: Session = Depends(get_db)
):
    """
    Main query endpoint
    - Accepts screenshot + question
    - Calls LLM API
    - Stores query in database
    - Returns answer
    """
    try:
        # Query LLM
        result = await llm_service.query(
            provider=request.provider,
            question=request.question,
            image_base64=request.image_data
        )
        
        # Store query in database (optional user association)
        query = Query(
            user_id=request.user_id,
            question=request.question,
            answer=result["answer"],
            image_data=request.image_data[:100],  # Store truncated for privacy
            llm_provider=request.provider,
            model_used=result["model"],
            tokens_used=result["tokens_used"]
        )
        db.add(query)
        db.commit()
        
        return QueryResponse(
            answer=result["answer"],
            model=result["model"],
            tokens_used=result["tokens_used"]
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/queries/history")
async def get_query_history(
    user_id: int,
    limit: int = 10,
    db: Session = Depends(get_db)
):
    """Get user's query history - For future use"""
    queries = db.query(Query)\
        .filter(Query.user_id == user_id)\
        .order_by(Query.created_at.desc())\
        .limit(limit)\
        .all()
    
    return {
        "queries": [
            {
                "id": q.id,
                "question": q.question,
                "answer": q.answer,
                "created_at": q.created_at.isoformat()
            }
            for q in queries
        ]
    }
```

---

## STEP 7: Auth Routes (Optional, 15 min)

### app/routes/auth.py
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from app.db.database import get_db
from app.models import User
import bcrypt
import jwt
from datetime import datetime, timedelta
from app.config import get_settings

router = APIRouter()
settings = get_settings()

class UserCreate(BaseModel):
    email: EmailStr
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

def create_token(user_id: int) -> str:
    payload = {
        "user_id": user_id,
        "exp": datetime.utcnow() + timedelta(hours=settings.jwt_expiration_hours)
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

@router.post("/register", response_model=Token)
async def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """Register new user"""
    # Check if user exists
    existing = db.query(User).filter(User.email == user_data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create user
    user = User(
        email=user_data.email,
        hashed_password=hash_password(user_data.password)
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Generate token
    token = create_token(user.id)
    return Token(access_token=token)

@router.post("/login", response_model=Token)
async def login(user_data: UserLogin, db: Session = Depends(get_db)):
    """Login user"""
    user = db.query(User).filter(User.email == user_data.email).first()
    
    if not user or not verify_password(user_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    token = create_token(user.id)
    return Token(access_token=token)
```

---

## STEP 8: Database Setup (5 min)

### Create database and tables

```bash
# Install PostgreSQL if needed
# Then create database

# Run migrations (create tables)
python -c "from app.db.database import engine; from app.models import Base; Base.metadata.create_all(bind=engine)"
```

### Or use Alembic for migrations (recommended):

```bash
pip install alembic
alembic init alembic
# Configure alembic.ini with your DATABASE_URL
alembic revision --autogenerate -m "Initial migration"
alembic upgrade head
```

---

## STEP 9: Run Backend (5 min)

### Install dependencies
```bash
cd backend
pip install -r requirements.txt
```

### Create .env file
```bash
cp .env.example .env
# Edit .env with your actual values
```

### Run server
```bash
python -m app.main
# Or with uvicorn directly
uvicorn app.main:app --reload --port 8000
```

### Test backend
```bash
curl http://localhost:8000/health
# Should return: {"status":"healthy"}
```

---

## PART B: Chrome Extension (Modified for Backend)

---

## STEP 10: Extension Project Structure (5 min)

```
extension/
├── manifest.json
├── background.js
├── content.js
├── overlay.css
├── popup.html
├── popup.js
├── config.js          # NEW: Backend URL config
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## STEP 11: Extension Config (5 min)

### config.js
```javascript
// Configuration for backend URL
const CONFIG = {
  BACKEND_URL: 'http://localhost:8000/api',
  // Change to production URL when deployed:
  // BACKEND_URL: 'https://your-backend.com/api'
};

// Make available globally
window.BACKEND_CONFIG = CONFIG;
```

---

## STEP 12: Updated manifest.json (5 min)

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Screen Query AI",
  "version": "1.0",
  "description": "Select any part of a page and ask questions about it",
  "permissions": [
    "activeTab",
    "storage"
  ],
  "host_permissions": [
    "<all_urls>",
    "http://localhost:8000/*",
    "https://your-backend.com/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["config.js", "content.js"],
      "css": ["overlay.css"],
      "run_at": "document_end"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "commands": {
    "toggle-selection": {
      "suggested_key": {
        "default": "Ctrl+B",
        "mac": "Command+B"
      },
      "description": "Toggle screen selection mode"
    }
  }
}
```

---

## STEP 13: Updated Background Worker (20 min)

### background.js
```javascript
// Import config
const BACKEND_URL = 'http://localhost:8000/api';

// Listen for screenshot requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureTab') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'queryLLM') {
    handleLLMQuery(request.question, request.imageData, request.provider)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// Keyboard shortcut handler
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggleSelection" });
      }
    });
  }
});

// Query backend instead of calling APIs directly
async function handleLLMQuery(question, imageData, provider) {
  try {
    // Get user settings (optional)
    const { userId } = await chrome.storage.sync.get(['userId']);
    
    // Call backend
    const response = await fetch(`${BACKEND_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question: question,
        image_data: imageData,
        provider: provider || 'openai',
        user_id: userId || null
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Backend request failed');
    }
    
    const data = await response.json();
    return { 
      answer: data.answer,
      model: data.model,
      tokens_used: data.tokens_used
    };
    
  } catch (error) {
    console.error('Backend query error:', error);
    return { error: error.message };
  }
}
```

---

## STEP 14: Content Script (Same as before, 45 min)

### content.js
Use the EXACT same content.js from the original implementation guide.

**No changes needed** - it just sends messages to background.js, which now calls the backend.

---

## STEP 15: Styling (Same as before, 20 min)

### overlay.css
Use the EXACT same overlay.css from the original implementation guide.

**No changes needed** - all styling remains the same.

---

## STEP 16: Updated Settings Popup (15 min)

### popup.html
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      width: 350px;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      margin: 0;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 16px 0;
      color: #1f2937;
    }
    .section {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 6px;
    }
    select, input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      box-sizing: border-box;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #4A90E2;
      box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.1);
    }
    .help-text {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }
    button {
      width: 100%;
      padding: 10px;
      background: #4A90E2;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover {
      background: #357ABD;
    }
    .status {
      margin-top: 12px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      text-align: center;
      display: none;
    }
    .status.success {
      background: #d1fae5;
      color: #065f46;
      display: block;
    }
    .status.error {
      background: #fee2e2;
      color: #991b1b;
      display: block;
    }
    .info-box {
      background: #f3f4f6;
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      color: #4b5563;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <h2>Screen Query AI</h2>
  
  <div class="section">
    <label for="provider">API Provider</label>
    <select id="provider">
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic (Claude)</option>
    </select>
  </div>
  
  <div class="section">
    <label for="backendUrl">Backend URL</label>
    <input type="text" id="backendUrl" placeholder="http://localhost:8000/api">
    <div class="help-text">
      URL of your backend server
    </div>
  </div>
  
  <button id="save">Save Settings</button>
  
  <div id="status" class="status"></div>
  
  <div class="section" style="margin-top: 20px;">
    <div class="info-box">
      <strong>How to use:</strong><br>
      Press <strong>Cmd+B</strong> (Mac) or <strong>Ctrl+B</strong> (Windows/Linux) to activate. Drag to select, then ask!
      <br><br>
      <strong>Note:</strong> Backend server must be running.
    </div>
  </div>
  
  <script src="popup.js"></script>
</body>
</html>
```

### popup.js
```javascript
document.addEventListener('DOMContentLoaded', async () => {
  const providerSelect = document.getElementById('provider');
  const backendUrlInput = document.getElementById('backendUrl');
  const saveButton = document.getElementById('save');
  const statusDiv = document.getElementById('status');
  
  // Load saved settings
  const { apiProvider, backendUrl } = await chrome.storage.sync.get([
    'apiProvider',
    'backendUrl'
  ]);
  
  if (apiProvider) {
    providerSelect.value = apiProvider;
  }
  
  if (backendUrl) {
    backendUrlInput.value = backendUrl;
  } else {
    backendUrlInput.value = 'http://localhost:8000/api';
  }
  
  // Save settings
  saveButton.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const url = backendUrlInput.value.trim();
    
    if (!url) {
      showStatus('Please enter backend URL', 'error');
      return;
    }
    
    try {
      // Test backend connection
      const response = await fetch(`${url.replace('/api', '')}/health`);
      if (!response.ok) {
        throw new Error('Backend not reachable');
      }
      
      // Save settings
      await chrome.storage.sync.set({
        apiProvider: provider,
        backendUrl: url
      });
      
      showStatus('Settings saved! Backend connected.', 'success');
      
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 2000);
      
    } catch (error) {
      showStatus('Error: Cannot connect to backend', 'error');
    }
  });
  
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
  }
});
```

---

## STEP 17: Testing (20 min)

### Backend Tests
```bash
# Test health endpoint
curl http://localhost:8000/health

# Test query endpoint
curl -X POST http://localhost:8000/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What do you see?",
    "image_data": "base64string...",
    "provider": "openai"
  }'
```

### Extension Tests
1. Load extension in Chrome
2. Configure backend URL in settings
3. Press Cmd+B and make selection
4. Submit query
5. Check backend logs for request
6. Verify response in extension

---

## Deployment Guide

### Backend Deployment (Production)

#### Option 1: Railway/Render
```bash
# Add to requirements.txt
gunicorn==21.2.0

# Create Procfile
web: gunicorn app.main:app -w 4 -k uvicorn.workers.UvicornWorker
```

#### Option 2: Docker
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Extension Update
Update `config.js` with production URL:
```javascript
const CONFIG = {
  BACKEND_URL: 'https://your-backend.com/api'
};
```

---

## Future RAG Implementation

### When you're ready to add RAG:

1. **Implement chunking** in `rag_service.py`
2. **Add document upload endpoint** in routes
3. **Modify query endpoint** to retrieve context
4. **Update LLM prompts** to include retrieved chunks

### Example RAG Query Flow:
```python
# In app/routes/query.py

# 1. Search vector DB for relevant chunks
relevant_chunks = await rag_service.search(
    user_id=request.user_id,
    query=request.question,
    n_results=3
)

# 2. Build context from chunks
context = "\n\n".join([chunk["document"] for chunk in relevant_chunks])

# 3. Query LLM with context + image
result = await llm_service.query_with_context(
    provider=request.provider,
    question=request.question,
    image_base64=request.image_data,
    context=context
)
```

---

## Summary

### What You Built:

**Backend:**
- ✅ FastAPI server with LLM integration
- ✅ PostgreSQL for user data & history
- ✅ ChromaDB ready for RAG
- ✅ Authentication system
- ✅ Query history tracking

**Extension:**
- ✅ Screenshot capture
- ✅ Selection UI
- ✅ Backend integration
- ✅ Settings management

### Development Time:
- Backend: ~2 hours
- Extension: ~1.5 hours
- **Total: ~3.5 hours**

### Ready for RAG:
Just implement the chunking/retrieval logic in `rag_service.py` and update the query endpoint!