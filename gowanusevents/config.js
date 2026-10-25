// Gowanus Events: hand-maintained configuration. scripts/refresh-gowanus.mjs reads this file
// but never writes it. The daily data lives in data.js; the scoring pipeline in pipeline.js.

// Gowanus Canal centerline, Butler St to Gowanus Bay (OpenStreetMap ways 25198744 + 25198767).
const CANAL = [[40.68158,-73.98693],[40.68131,-73.98711],[40.67837,-73.98911],[40.67828,-73.98914],[40.67791,-73.98918],[40.67748,-73.9892],[40.67736,-73.98922],[40.6773,-73.98926],[40.67563,-73.99069],[40.67587,-73.99195],[40.67594,-73.99244],[40.67605,-73.99311],[40.67609,-73.99368],[40.67608,-73.99396],[40.67603,-73.99426],[40.67594,-73.99454],[40.67584,-73.99478],[40.67576,-73.99494],[40.67554,-73.99519],[40.67524,-73.99549],[40.67483,-73.9959],[40.67432,-73.99629],[40.67286,-73.99743],[40.67204,-73.99808],[40.67123,-73.99882],[40.6706,-73.99914],[40.66877,-73.99983],[40.66807,-74.00073],[40.66728,-74.00221],[40.66671,-74.00354],[40.66475,-74.00935]];

// Venues with a fixed identity. The refresh matches event venues against these names and
// aliases first and geocodes anything else (cached in scripts/gowanus-venues.json); a curated
// entry always wins over a geocoded one. `tier` is a quality floor for venues that book
// reliably well; `mega` keeps arena-scale venues out of the ranking.
const CURATED_VENUES = {
  bellhouse:     { name: 'The Bell House', addr: '149 7th St', lat: 40.67373, lon: -73.99168, tier: 7.0, aliases: ['bell house'] },
  littlefield:   { name: 'Littlefield', addr: '635 Sackett St', lat: 40.67848, lon: -73.98338, tier: 6.5, aliases: ['littlefield'] },
  publicrecords: { name: 'Public Records', addr: '233 Butler St', lat: 40.68217, lon: -73.98639, tier: 7.0, aliases: ['public records'] },
  unionhall:     { name: 'Union Hall', addr: '702 Union St', lat: 40.67604, lon: -73.98009, tier: 6.5, aliases: ['union hall'] },
  roulette:      { name: 'Roulette', addr: '509 Atlantic Ave', lat: 40.68556, lon: -73.98072, tier: 7.0, aliases: ['roulette'] },
  barbes:        { name: 'Barbès', addr: '376 9th St', lat: 40.66774, lon: -73.98388, tier: 6.5, aliases: ['barbes'] },
  jalopy:        { name: 'Jalopy Theatre', addr: '315 Columbia St', lat: 40.68133, lon: -74.00421, aliases: ['jalopy'] },
  conservatory:  { name: 'Brooklyn Conservatory of Music', addr: '58 7th Ave', lat: 40.67596, lon: -73.97472, aliases: ['brooklyn conservatory'] },
  powerhouse:    { name: 'Powerhouse Arts', addr: '322 3rd Ave', lat: 40.67633, lon: -73.98822, tier: 6.5, aliases: ['powerhouse arts'] },
  royalpalms:    { name: 'Royal Palms Shuffleboard Club', addr: '514 Union St', lat: 40.67874, lon: -73.98685, aliases: ['royal palms'] },
  freddys:       { name: "Freddy's Bar", addr: '627 5th Ave', lat: 40.66329, lon: -73.99114, aliases: ['freddy s bar', 'freddys bar', 'freddy s backroom'] },
  vanalen:       { name: 'Van Alen Institute', addr: '303 Bond St', lat: 40.68005, lon: -73.98923, tier: 6.0, aliases: ['van alen'] },
  threes:        { name: 'Threes Brewing', addr: '333 Douglass St', lat: 40.67972, lon: -73.98216, aliases: ['threes brewing'] },
  oldstonehouse: { name: 'Old Stone House', addr: '336 3rd St', lat: 40.67301, lon: -73.98460, aliases: ['old stone house', 'washington park'] },
  dredgers:      { name: 'Gowanus Dredgers', addr: '165 2nd St', lat: 40.67708, lon: -73.99005, aliases: ['gowanus dredgers'] },
  barclays:      { name: 'Barclays Center', addr: '620 Atlantic Ave', lat: 40.68386, lon: -73.97718, mega: true, aliases: ['barclays center'] },
  brooklynsteel: { name: 'Brooklyn Steel', addr: '319 Frost St', lat: 40.71939, lon: -73.93875, aliases: ['brooklyn steel'] },
  kingstheatre:  { name: 'Kings Theatre', addr: '1027 Flatbush Ave', lat: 40.64597, lon: -73.95797, mega: true, aliases: ['kings theatre'] },
  pioneerworks:  { name: 'Pioneer Works', addr: '159 Pioneer St', lat: 40.67938, lon: -74.01189, aliases: ['pioneer works'] },
  billieholiday: { name: 'The Billie Holiday Theatre', addr: '1368 Fulton St', lat: 40.67997, lon: -73.94544, aliases: ['billie holiday theatre'] },
};

// Every source the refresh checks, grouped by the model call that covers it. Sources with no
// URL (or a JavaScript-only calendar) are reached by web search. Keys are stable: events
// carry them, and carry-forward after a failed call matches on them.
const SOURCES = {
  // Music venues
  pr:  { name: 'Public Records', url: 'https://publicrecords.nyc/', kind: 'venue', group: 'music' },
  fr:  { name: "Freddy's Bar", url: 'https://freddysbar.com/events', kind: 'venue', group: 'music' },
  bb:  { name: 'Barbès', url: 'https://www.barbesbrooklyn.com/events', kind: 'venue', group: 'music', note: 'Calendar loads by JavaScript; reach it by search.' },
  ro:  { name: 'Roulette', url: 'https://roulette.org/calendar/', kind: 'venue', group: 'music' },
  jt:  { name: 'Jalopy Theatre', url: 'https://jalopytheatre.netlify.app/performances', kind: 'venue', group: 'music' },
  l13: { name: 'Lucky 13 Saloon', url: '', kind: 'venue', group: 'music', note: 'No known calendar URL; search for its shows.' },
  bc:  { name: 'Brooklyn Conservatory of Music', url: '', kind: 'institution', group: 'music', note: 'Search for its public concerts and recitals.' },
  // Comedy, talks and mixed stages
  bh:  { name: 'The Bell House', url: 'https://www.thebellhouseny.com/', kind: 'venue', group: 'stages' },
  lf:  { name: 'Littlefield', url: 'https://littlefieldnyc.com/', kind: 'venue', group: 'stages' },
  uh:  { name: 'Union Hall', url: 'https://www.unionhallny.com/', kind: 'venue', group: 'stages' },
  va:  { name: 'Van Alen Institute', url: 'https://www.vanalen.org/events', kind: 'institution', group: 'stages' },
  ph:  { name: 'Powerhouse Arts', url: 'https://www.powerhousearts.org/events', kind: 'institution', group: 'stages' },
  th:  { name: 'Threes Brewing', url: 'https://www.threesbrewing.com/pages/public-events', kind: 'venue', group: 'stages', note: 'Calendar loads by JavaScript; reach it by search.' },
  rp:  { name: 'Royal Palms', url: 'http://www.royalpalmsbrooklyn.com/calendar', kind: 'venue', group: 'stages' },
  // Community, festivals, outdoors
  ebg: { name: 'Eventbrite: Gowanus', url: 'https://www.eventbrite.com/d/ny--brooklyn/gowanus/', kind: 'aggregator', group: 'community' },
  ebp: { name: 'Eventbrite: Park Slope', url: 'https://www.eventbrite.com/d/ny--brooklyn/park-slope/', kind: 'aggregator', group: 'community' },
  ebc: { name: 'Eventbrite: Carroll Gardens', url: 'https://www.eventbrite.com/d/ny--brooklyn/carroll-gardens/', kind: 'aggregator', group: 'community' },
  lt:  { name: 'The Longest Table', url: 'https://www.longesttablecommunity.org/', kind: 'institution', group: 'community' },
  psc: { name: 'Park Slope Civic Council', url: 'https://parkslopeciviccouncil.org/events/', kind: 'institution', group: 'community' },
  gd:  { name: 'Gowanus Dredgers', url: '', kind: 'institution', group: 'community', note: 'Canoe trips and canal events; search for them.' },
  gc:  { name: 'Gowanus Canal Conservancy', url: 'https://gowanuscanalconservancy.org/events/', kind: 'institution', group: 'community' },
  os:  { name: 'Old Stone House', url: 'https://theoldstonehouse.org/events/', kind: 'institution', group: 'community' },
  ag:  { name: 'Arts Gowanus', url: 'https://www.artsgowanus.org/events', kind: 'institution', group: 'community' },
  // Local press and listings
  bp:  { name: 'Brooklyn Paper: Gowanus', url: 'https://events.brooklynpaper.com/communities/new-york-metro-area/nyc/brooklyn/gowanus/', kind: 'aggregator', group: 'press' },
  bbp: { name: 'Brooklyn Bridge Parents', url: 'https://brooklynbridgeparents.com/outdoor-festivals-and-street-fairs-in-brooklyn-in-2026/', kind: 'aggregator', group: 'press' },
  // Not fetched directly
  web: { name: 'Web search', url: '', kind: 'aggregator', group: null },
  pin: { name: 'Hand-added', url: '', kind: 'curated', group: null },
};

// Undated standing programs, shown on the Every Week tab.
const STANDING = [
  { v: 'royalpalms', title: 'Family Sundays', when: 'Select Sundays, 12–8 PM', note: 'All ages; shuffleboard for 8+. Courts $60/hr. The site does not say which Sundays.', url: 'http://www.royalpalmsbrooklyn.com/familysundays' },
];

// Hand-confirmed events that must appear even if the daily run misses them (Candlewood's
// injectPinned). Same shape as a data.js event; dedupe merges them with any copy the run finds.
const PINNED = [
  { v: 'oldstonehouse', d: '2026-10-31', t: '6:30 PM', title: "Park Slope Civic Council Children's Halloween Parade", type: 'Parade', cat: 'community', fq: 8.0, src: 'pin', price: 'free',
    url: 'https://parkslopeciviccouncil.org/events/halloween-parade/', blurb: 'Steps off at 7th Ave & 14th St (line-up 6 PM) and ends at the Old Stone House. Free, all ages.' },
];
