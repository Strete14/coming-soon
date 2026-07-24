// api/oblio-invoice.js
// Creates and sends a fiscal invoice via Oblio after a successful Stripe payment.
// Called internally by the stripe-webhook function.
// Uses OAuth2 token from Oblio API, then creates a VAT-exempt invoice
// and emails it automatically to the customer.

const OBLIO_API_KEY = process.env.OBLIO_API_KEY;
const OBLIO_EMAIL = process.env.OBLIO_EMAIL;
const OBLIO_CUI = process.env.OBLIO_CUI;
const OBLIO_INVOICE_SERIES = process.env.OBLIO_INVOICE_SERIES || "PR";

const PLAN_NAMES = {
  standard: "PhysioRoutine Standard - 7-Day Rehabilitation Programme",
  premium: "PhysioRoutine Premium - 14-Day Rehabilitation Programme",
};

const PLAN_PRICES = {
  standard: 10,
  premium: 35,
};

async function getOblioToken() {
  const r = await fetch("https://www.oblio.eu/api/authorize/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OBLIO_EMAIL,
      client_secret: OBLIO_API_KEY,
      grant_type: "client_credentials",
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error("Oblio auth failed: " + text);
  }

  const data = await r.json();
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OBLIO_API_KEY || !OBLIO_EMAIL || !OBLIO_CUI) {
    return res.status(500).json({ error: "Oblio is not configured" });
  }

  const { userEmail, userName, plan } = req.body;

  if (!userEmail || !plan) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const productName = PLAN_NAMES[plan];
  const price = PLAN_PRICES[plan];

  if (!productName || !price) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  try {
    // Step 1: Get Oblio access token
    const token = await getOblioToken();

    // Step 2: Create the invoice
    const today = new Date().toISOString().split("T")[0];

    const invoicePayload = {
      cif: OBLIO_CUI,
      client: {
        cif: "",
        name: userName || "Client PhysioRoutine",
        rc: "",
        code: "",
        address: "",
        state: "",
        city: "",
        country: "Romania",
        phone: "",
        email: userEmail,
        save: false,
      },
      issueDate: today,
      dueDate: today,
      seriesName: OBLIO_INVOICE_SERIES,
      collect: {},
      referenceDocument: {},
      language: "RO",
      precision: 2,
      currency: "EUR",
      products: [
        {
          name: productName,
          code: plan === "premium" ? "PHYSIO-PREMIUM" : "PHYSIO-STANDARD",
          description: "",
          price: price,
          measuringUnit: "buc",
          currency: "EUR",
          vatName: "Fara TVA",
          vatPercentage: 0,
          vatIncluded: false,
          quantity: 1,
          productType: "Serviciu",
          save: false,
        },
      ],
      issuerName: "",
      issuerCif: "",
      noticeNumber: "",
      internalNote: "Plata online via Stripe - PhysioRoutine",
      deputyName: "",
      deputyIdentityCard: "",
      deputyAuto: "",
      selesAgent: "",
      mentions: "Factura emisa in EUR. TVA neaplicabil conform art. 310 din Codul Fiscal - PFA neplatitor de TVA.",
      value: price,
      isTaxPayer: false,
      useStock: false,
      sendEmail: true,
    };

    const invoiceRes = await fetch("https://www.oblio.eu/api/docs/invoice", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(invoicePayload),
    });

    const invoiceData = await invoiceRes.json();

    if (!invoiceRes.ok) {
      console.error("Oblio invoice creation failed:", invoiceData);
      return res.status(500).json({ error: "Invoice creation failed", details: invoiceData });
    }

    console.log("Oblio invoice created:", invoiceData);
    return res.status(200).json({ success: true, invoice: invoiceData });
  } catch (e) {
    console.error("Oblio invoice error:", e);
    return res.status(500).json({ error: e.message });
  }
}
