require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

async function createIndex() {
  try {
    console.log(`Creating text index on "chunk_text" for collection "${COLLECTION}"...`);
    
    await qdrant.createPayloadIndex(COLLECTION, {
      field_name: 'chunk_text',
      field_schema: {
        type: 'text',
        tokenizer: 'word',
        lowercase: true,
        min_token_len: 2,
        max_token_len: 20,
      },
    });
    
    console.log('✅ Text index created successfully.');
    console.log('Now Qdrant can do full-text search on chunk_text.');

    // Verify it exists
    const collectionInfo = await qdrant.getCollection(COLLECTION);
    console.log('\nPayload schema for chunk_text:');
    console.log(JSON.stringify(collectionInfo.payload_schema?.chunk_text, null, 2));

  } catch (err) {
    if (err.message?.includes('already exists')) {
      console.log('ℹ️  Index already exists — no action needed.');
    } else {
      console.error('❌ Failed:', err.message);
      console.error(err);
    }
  }
  process.exit(0);
}

createIndex();