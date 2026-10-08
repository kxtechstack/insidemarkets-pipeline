import "dotenv/config";
import { LinkupClient } from "linkup-sdk";

const client = new LinkupClient({ apiKey: process.env.LINKUP_API_KEY });

const res = await client.search({
  query: "fintech regulation UAE",
  depth: "standard",
  outputType: "searchResults",
  fromDate: "2026-09-01",
  toDate: "2026-10-08",
});

console.log(JSON.stringify(res, null, 2));