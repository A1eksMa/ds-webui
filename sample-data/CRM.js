// ФИКТИВНЫЕ данные для разработки.
window.DS = window.DS || { sources: {} };
window.DS.sources["CRM"] = {
  meta: { name: "CRM", key: "customer_id", as_of: 1717200000, generated_at: 1717372800 },
  data: [
    { customer_id: "101", email: "alice@example.com", phone: "+7-900-000-0001", status: "active" },
    { customer_id: "102", email: "bob@example.com",   phone: null,              status: "active" },
    { customer_id: "103", email: "carol@example.com", status: "blocked" },
    { customer_id: "104", email: "dave@example.com",  phone: "+7-900-000-0004", status: "active" }
  ]
};
