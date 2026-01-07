const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 7860;
const REQUEST_TIMEOUT = 120000; // 2 minutes

const API_KEY = process.env.API_KEY;

console.log("=".repeat(60));
console.log("🚀 NVIDIA NIM PROXY SERVER STARTUP");
console.log("=".repeat(60));

if (!API_KEY) {
    console.error("❌ CRITICAL: API_KEY environment variable is MISSING.");
    console.error("   Set it in Hugging Face Space Secrets!");
} else {
    console.log(`✅ API Key Loaded (Length: ${API_KEY.trim().length} chars)`);
}

app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        apiKeyConfigured: !!API_KEY
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Statistics tracking
let stats = {
    totalRequests: 0,
    streamingRequests: 0,
    thinkingDetected: 0,
    errors: 0
};

app.get('/stats', (req, res) => {
    res.json(stats);
});

// Main proxy endpoint
app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    const modelName = req.body.model || "unspecified";
    const isStreaming = req.body.stream === true;
    
    stats.totalRequests++;
    if (isStreaming) stats.streamingRequests++;

    console.log("\n" + "─".repeat(60));
    console.log(`📥 [${requestId}] NEW REQUEST`);
    console.log(`   Model: ${modelName}`);
    console.log(`   Stream: ${isStreaming}`);
    console.log(`   Messages: ${req.body.messages?.length || 0}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    
    if (!API_KEY) {
        stats.errors++;
        console.error(`❌ [${requestId}] API_KEY missing`);
        return res.status(500).json({ 
            error: "Server misconfigured: API_KEY missing" 
        });
    }

    try {
        const response = await axios({
            method: 'post',
            url: "https://integrate.api.nvidia.com/v1/chat/completions",
            headers: { 
                'Authorization': `Bearer ${API_KEY.trim()}`, 
                'Content-Type': 'application/json',
                'Accept': isStreaming ? 'text/event-stream' : 'application/json'
            },
            data: req.body,
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT
        });

        console.log(`✅ [${requestId}] NVIDIA Connected: ${response.status}`);

        if (isStreaming) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Request-ID', requestId);

            // Stream inspector to detect thinking
            let buffer = '';
            let chunkCount = 0;
            let thinkingDetected = false;
            let thinkingContent = [];

            response.data.on('data', (chunk) => {
                chunkCount++;
                const chunkStr = chunk.toString();
                buffer += chunkStr;

                // Parse SSE chunks to detect thinking
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                lines.forEach(line => {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        
                        if (data === '[DONE]') {
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;
                            
                            // Detect thinking/reasoning indicators
                            if (delta) {
                                // Check for reasoning/thinking content
                                if (delta.reasoning_content || 
                                    delta.thinking || 
                                    parsed.choices?.[0]?.message?.reasoning_content) {
                                    
                                    if (!thinkingDetected) {
                                        thinkingDetected = true;
                                        stats.thinkingDetected++;
                                        console.log(`🧠 [${requestId}] THINKING/REASONING DETECTED!`);
                                    }
                                    
                                    const thinking = delta.reasoning_content || 
                                                   delta.thinking || 
                                                   parsed.choices?.[0]?.message?.reasoning_content;
                                    
                                    if (thinking) {
                                        thinkingContent.push(thinking);
                                        console.log(`   💭 Thinking: ${thinking.substring(0, 100)}...`);
                                    }
                                }
                                
                                // Regular content
                                if (delta.content) {
                                    process.stdout.write('.');
                                }
                            }
                        } catch (e) {
                            // Not JSON, skip
                        }
                    }
                });

                // Forward chunk to client
                res.write(chunk);
            });

            response.data.on('end', () => {
                res.end();
                const duration = Date.now() - startTime;
                console.log(`\n✅ [${requestId}] COMPLETED`);
                console.log(`   Duration: ${duration}ms`);
                console.log(`   Chunks: ${chunkCount}`);
                if (thinkingDetected) {
                    console.log(`   🧠 Thinking tokens: ${thinkingContent.length}`);
                    console.log(`   Full thinking: ${thinkingContent.join('')}`);
                }
                console.log("─".repeat(60));
            });

            response.data.on('error', (err) => {
                console.error(`❌ [${requestId}] Stream error:`, err.message);
                stats.errors++;
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Stream error' });
                }
            });

        } else {
            // Non-streaming response
            let responseData = '';
            
            for await (const chunk of response.data) {
                responseData += chunk;
            }

            const duration = Date.now() - startTime;
            console.log(`✅ [${requestId}] COMPLETED (non-stream): ${duration}ms`);
            
            // Check for thinking in non-streaming response
            try {
                const parsed = JSON.parse(responseData);
                if (parsed.choices?.[0]?.message?.reasoning_content) {
                    console.log(`🧠 [${requestId}] THINKING DETECTED (non-stream)!`);
                    console.log(`   💭 ${parsed.choices[0].message.reasoning_content}`);
                    stats.thinkingDetected++;
                }
            } catch (e) {
                // Ignore parse errors
            }
            
            console.log("─".repeat(60));
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-Request-ID', requestId);
            res.send(responseData);
        }

    } catch (error) {
        stats.errors++;
        const duration = Date.now() - startTime;
        
        console.error(`\n❌ [${requestId}] ERROR after ${duration}ms`);
        
        if (error.code === 'ECONNABORTED') {
            console.error(`   ⏱️  Timeout after ${REQUEST_TIMEOUT}ms`);
            return res.status(504).json({ error: "Request timeout" });
        }

        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            
            let errorBody = '';
            try {
                for await (const chunk of error.response.data) {
                    errorBody += chunk;
                }
                console.error(`   Detail: ${errorBody}`);
            } catch (e) {
                console.error(`   Could not parse error response`);
            }

            res.status(error.response.status).send(errorBody || "Upstream error");
        } else if (error.request) {
            console.error(`   No response from NVIDIA (network issue)`);
            res.status(504).json({ error: "Gateway timeout" });
        } else {
            console.error(`   Internal error: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
        
        console.log("─".repeat(60));
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Proxy Server Running`);
    console.log(`   URL: http://0.0.0.0:${PORT}`);
    console.log(`   Endpoints:`);
    console.log(`     GET  /         - Status check`);
    console.log(`     GET  /health   - Health check`);
    console.log(`     GET  /stats    - Usage statistics`);
    console.log(`     POST /v1/chat/completions - Main proxy`);
    console.log("=".repeat(60) + "\n");
});
