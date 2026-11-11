
"use strict";

require("dotenv").config();

const { askAI, isAIConfigured, getAIProviderLabel, getAIModel } = require("./services/ai");

async function testAI() {
  console.log("1. Konfigirasyon AI:", getAIProviderLabel(), getAIModel(), isAIConfigured());

  if (!isAIConfigured()) {
    console.log("ERÈ: GEMINI_API_KEY oswa ANTHROPIC_API_KEY manke (gade AI_PROVIDER).");
    process.exitCode = 1;
    return;
  }

  try {
    const answer = await askAI(
      "Reponn sèlman: TOPFEROS MD AI konekte!"
    );

    console.log("2. REPONS AI:", answer);
    console.log("TÈS REYISI: " + getAIProviderLabel() + " reponn.");
  } catch (error) {
    console.error("TÈS ECHWE:", error.message);
    process.exitCode = 1;
  }
}

testAI();
