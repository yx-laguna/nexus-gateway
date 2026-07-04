process.env.AGODA_DB_PATH = "./agoda_hotels.sqlite";
process.env.AGODA_CITY_LOOKUP_PATH = "./agoda_city_lookup.json";
const { findCity } = await import("./agoda-city-lookup.ts");
const { getHotelsByIds, isAgodaDbAvailable } = await import("./agoda-db.ts");

console.log("city 'bangkok' ->", findCity("Bangkok"));
console.log("city 'new york' ->", findCity("New York"));
console.log("city 'zzzznotreal' ->", findCity("zzzznotreal"));

console.log("db available:", isAgodaDbAvailable());
const rows = getHotelsByIds([1, 1007, 999999999]);
console.log("hotel 1 ->", rows.get(1));
console.log("hotel 1007 ->", rows.get(1007));
console.log("hotel 999999999 (missing) ->", rows.get(999999999));
