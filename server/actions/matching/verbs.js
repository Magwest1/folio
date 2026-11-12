// Small past-tense -> base-form tables for English and Norwegian, so "sent the budget to Anna" can be compared with
// "Send the budget to Anna" and "ringte Kari" with "Ringe Kari". Only verbs that people report as finished
// (the same families as the detector's completion lexicon) are listed. Values are base forms; similarity.js
// stems them with the same rules it applies to every other word, so inflections of the base meet the same stem.
const pairs = (list) => Object.fromEntries(list.flatMap(([base, forms]) => forms.split(' ').map((form) => [form, base])))

export const PAST_TO_BASE_EN = pairs([
  ['send', 'sent'], ['call', 'called'], ['email', 'emailed e-mailed'], ['book', 'booked'], ['buy', 'bought'], ['fix', 'fixed'],
  ['review', 'reviewed'], ['write', 'wrote written'], ['finish', 'finished'], ['complete', 'completed'], ['schedule', 'scheduled'],
  ['prepare', 'prepared'], ['ask', 'asked'], ['order', 'ordered'], ['pay', 'paid'], ['update', 'updated'], ['submit', 'submitted'],
  ['deliver', 'delivered'], ['sign', 'signed'], ['cancel', 'cancelled canceled'], ['text', 'texted'], ['message', 'messaged'],
  ['ping', 'pinged'], ['confirm', 'confirmed'], ['upload', 'uploaded'], ['share', 'shared'], ['forward', 'forwarded'],
  ['reply', 'replied'], ['respond', 'responded'], ['contact', 'contacted'], ['arrange', 'arranged'], ['create', 'created'],
  ['draft', 'drafted'], ['finalize', 'finalized finalised finalise'], ['renew', 'renewed'], ['register', 'registered'],
  ['invite', 'invited'], ['print', 'printed'], ['handle', 'handled'], ['sort', 'sorted'], ['resolve', 'resolved'], ['file', 'filed'],
  ['phone', 'phoned'], ['ring', 'rang'], ['speak', 'spoke'], ['talk', 'talked'], ['meet', 'met'], ['clean', 'cleaned'],
  ['return', 'returned'], ['pick', 'picked'], ['make', 'made'], ['take', 'took taken'], ['give', 'gave given'], ['tell', 'told'],
  ['find', 'found'], ['mail', 'mailed'], ['check', 'checked'], ['do', 'did done'], ['get', 'got'], ['organize', 'organized organised'],
  ['pack', 'packed'], ['collect', 'collected'], ['transfer', 'transferred'], ['follow', 'followed'], ['remind', 'reminded'],
])

export const PAST_TO_BASE_NO = pairs([
  ['send', 'sendte sendt'], ['ring', 'ringte ringt'], ['bestill', 'bestilte bestilt'], ['kjøp', 'kjøpte kjøpt'], ['fiks', 'fikset'],
  ['skriv', 'skrev skrevet'], ['ordne', 'ordnet'], ['gjør', 'gjorde gjort'], ['ferdigstill', 'ferdigstilte ferdigstilt'],
  ['avtal', 'avtalte avtalt'], ['forbered', 'forberedte forberedt'], ['spør', 'spurte spurt'], ['betal', 'betalte betalt'],
  ['oppdater', 'oppdaterte oppdatert'], ['lever', 'leverte levert'], ['signer', 'signerte signert'], ['sjekk', 'sjekket'],
  ['book', 'booket booka'], ['svar', 'svarte svart'], ['bekreft', 'bekreftet'], ['kontakt', 'kontaktet'], ['lag', 'lagde laget'],
  ['del', 'delte delt'], ['løs', 'løste løst'], ['hent', 'hentet'], ['rydd', 'ryddet'], ['planlegg', 'planla planlagt'],
  ['les', 'leste lest'], ['møt', 'møtte møtt'], ['snakk', 'snakket'], ['ta', 'tok tatt'], ['finn', 'fant funnet'],
  ['meld', 'meldte meldt'], ['avlys', 'avlyste avlyst'], ['forny', 'fornyet'],
  ['følg', 'fulgte fulgt'], ['minn', 'minnet'], ['purr', 'purret'], ['vask', 'vasket'], ['handl', 'handlet'],
  ['last', 'lastet'], ['inviter', 'inviterte invitert'], ['registrer', 'registrerte registrert'], ['rett', 'rettet'],
])

export const PAST_TO_BASE = { ...PAST_TO_BASE_EN, ...PAST_TO_BASE_NO }

// Verb forms that report a finished action but are not themselves a tense of a task verb.
export const DONE_WORDS = new Set(['done', 'finished', 'completed', 'ferdig', 'ferdigstilt', 'fullført', 'gjort', 'klar'])

// "Started the report" and "begynte på rapporten" are progress, never completion.
export const PARTIAL_PROGRESS = /(?<![\p{L}\p{N}])(?:started|starting|began|begun|beginning|working\s+on|worked\s+on|partly|partially|half(?:way|-?done)?|almost|nearly|in\s+progress|under\s+way|not\s+finished|not\s+done|begynte|begynt|begynner|påbegynt|startet|jobber\s+med|jobbet\s+med|holder\s+på|delvis|nesten|halvveis|halvparten|underveis|ikke\s+ferdig)(?![\p{L}\p{N}])/iu

// Negated or not-yet statements: "haven't sent it yet", "har ikke sendt den ennå".
export const NOT_YET = /(?<![\p{L}\p{N}])(?:not|never|haven['’]?t|hasn['’]?t|hadn['’]?t|didn['’]?t|yet\s+to|still\s+need|still\s+haven|forgot(?:ten)?|ikke|aldri|ennå\s+ikke|glemte|glemt|ikke\s+ennå|mangler\s+å|gjenstår)(?![\p{L}\p{N}])/iu
