import { GoogleGenerativeAI } from "@google/generative-ai";

const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "mock" || apiKey.trim() === "") {
    return null;
  }
  return new GoogleGenerativeAI(apiKey);
};

export async function parseTextWithGemini(text) {
  const genAI = getGenAI();
  if (!genAI) {
    console.log("Mock Mode: Parsing text locally without Gemini API key");
    return mockParse(text);
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  
  const prompt = `Analyze the following transaction entry from a shop owner. Extract structured information.
Text: "${text}"

You must return a valid JSON object matching the schema below:
{
  "type": "sale" | "purchase" | "expense" | "credit",
  "item": string,
  "qty": number,
  "unit_price": number,
  "total": number
}

Instructions:
- If the quantity or unit price is missing, estimate them logically based on the total. E.g. "bought sugar for 200" could be item: "sugar", qty: 1, unit_price: 200, total: 200.
- If total is missing, calculate it as qty * unit_price.
- The "type" must be one of: "sale" (received money for goods), "purchase" (spent money to buy inventory/stock), "expense" (spent money on bills, rent, fees, wages), "credit" (customer took goods without paying, or owes money).
- Keep item name short, clear, and in English (or Swahili if standard, e.g., "sugar", "maize", "chapati").
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("Gemini API error:", error);
    return mockParse(text);
  }
}

export async function parseAudioWithGemini(audioBuffer, mimeType) {
  const genAI = getGenAI();
  if (!genAI) {
    console.log("Mock Mode: Parsing audio locally without Gemini API key");
    return mockParse("voice entry: sold 10 loaves at 50 each");
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `Analyze the accompanying audio message from a shop owner logging a transaction.
Transcribe and extract structured information.

You must return a valid JSON object matching the schema below:
{
  "type": "sale" | "purchase" | "expense" | "credit",
  "item": string,
  "qty": number,
  "unit_price": number,
  "total": number
}

Instructions:
- The audio is a spoken phrase like "sold 10 loaves at 50 each" or "nimenunua mafuta ya 1500".
- If the quantity or unit price is missing, estimate them logically based on the total.
- If total is missing, calculate it as qty * unit_price.
- The "type" must be one of: "sale" (received money), "purchase" (bought inventory), "expense" (general expenses/bills), "credit" (customer took on credit/owes money).
`;

  try {
    const base64Audio = audioBuffer.toString("base64");
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("Gemini API error parsing audio:", error);
    return mockParse("voice entry: sold 10 loaves at 50 each");
  }
}

function mockParse(text) {
  const lower = text.toLowerCase();
  let type = "sale";
  let item = "Loaves / Bread";
  let qty = 10;
  let unit_price = 50;
  let total = 500;

  // Simple heuristic parser for testing offline
  if (lower.includes("buy") || lower.includes("bought") || lower.includes("nunua") || lower.includes("purchase")) {
    type = "purchase";
    item = "Flour Bags";
    qty = 5;
    unit_price = 400;
    total = 2000;
  } else if (lower.includes("expense") || lower.includes("rent") || lower.includes("token") || lower.includes("fee") || lower.includes("lipa")) {
    type = "expense";
    item = "Electricity Tokens";
    qty = 1;
    unit_price = 300;
    total = 300;
  } else if (lower.includes("credit") || lower.includes("kopa") || lower.includes("debt") || lower.includes("owes")) {
    type = "credit";
    item = "Credit (Mama Mboga)";
    qty = 1;
    unit_price = 150;
    total = 150;
  }

  // Overwrite details based on some simple regex match for text if possible
  const numbers = text.match(/\d+/g);
  if (numbers && numbers.length >= 2) {
    qty = parseFloat(numbers[0]) || 1;
    unit_price = parseFloat(numbers[1]) || 100;
    total = qty * unit_price;
  } else if (numbers && numbers.length === 1) {
    total = parseFloat(numbers[0]) || 100;
    unit_price = total;
    qty = 1;
  }

  if (text !== "voice entry: sold 10 loaves at 50 each" && text !== "voice entry") {
    // If the user actually typed something, try to extract item name
    const cleanedText = text.replace(/(sold|bought|buy|spent|expense|credit|at|each|for|bags|loaves|\d+)/gi, "").trim();
    if (cleanedText.length > 2) {
      item = cleanedText;
    }
  }

  return { type, item, qty, unit_price, total };
}
