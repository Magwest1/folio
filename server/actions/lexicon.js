// Rule tables for the deterministic action detector. English and Norwegian patterns are kept as data so the
// detector stays small. In pattern sources `‹` and `›` are Unicode-aware word boundaries (the ASCII `\b`
// does not treat å, æ and ø as letters).
const START = '(?<![\\p{L}\\p{N}_])'
const END = '(?![\\p{L}\\p{N}_])'
export const rx = (source, flags = 'iu') => new RegExp(source.replaceAll('‹', START).replaceAll('›', END), flags)
const words = (list) => list.join('|')

const PAST_EN = words([
  'sent', 'called', 'emailed', 'e-mailed', 'booked', 'bought', 'fixed', 'reviewed', 'wrote', 'written', 'finished', 'completed',
  'scheduled', 'prepared', 'asked', 'ordered', 'paid', 'updated', 'submitted', 'delivered', 'signed', 'cancelled', 'canceled',
  'texted', 'messaged', 'pinged', 'confirmed', 'uploaded', 'shared', 'forwarded', 'replied', 'responded', 'contacted',
  'arranged', 'created', 'drafted', 'finalized', 'finalised', 'renewed', 'registered', 'invited', 'printed', 'handled', 'sorted',
  'resolved', 'filed', 'done',
])
const PAST_NO = words([
  'sendte', 'sendt', 'ringte', 'ringt', 'bestilte', 'bestilt', 'kjøpte', 'kjøpt', 'fikset', 'skrev', 'skrevet', 'ordnet',
  'gjorde', 'gjort', 'ferdigstilte', 'ferdigstilt', 'avtalte', 'avtalt', 'forberedte', 'forberedt', 'spurte', 'spurt',
  'betalte', 'betalt', 'oppdaterte', 'oppdatert', 'leverte', 'levert', 'signerte', 'signert', 'sjekket', 'booket', 'booka',
  'svarte', 'svart', 'bekreftet', 'kontaktet', 'lagde', 'laget', 'delte', 'delt', 'løste', 'løst',
])
const PRETERITE_NO = words(['sendte', 'ringte', 'bestilte', 'kjøpte', 'fikset', 'skrev', 'ordnet', 'gjorde', 'leverte', 'betalte', 'oppdaterte', 'svarte', 'kontaktet', 'ferdigstilte', 'booket', 'sjekket'])
const STATE_PARTICIPLES = 'sent|filed|done|booked|fixed|completed|finished|sendt|bestilt|gjort|fikset|levert|ferdig|ferdigstilt|løst|ordnet|avtalt|betalt|booket|kjøpt|skrevet|oppdatert|delivered|paid|signed|resolved|handled'

export const COMPLETION = [
  rx(`‹(?:i|we|he|she|they|you|jeg|vi|han|hun|de|du)(?:['’]ve|['’]d)?\\s+(?:(?:have|has|had|already|just|also|then|finally|now|har|hadde|allerede|nettopp|også)\\s+)*(?:${PAST_EN}|${PAST_NO})›`),
  rx(`‹(?:have|has|had|har|hadde)\\s+(?:already\\s+|just\\s+|allerede\\s+|nettopp\\s+)?(?:${PAST_EN}|${PAST_NO})›`),
  rx(`‹(?:${PAST_EN})\\s+(?:the|a|an|it|them|him|her|that|this|those|these|our|my|his|their|out|over|in|off|up)›`),
  rx(`‹(?:${PRETERITE_NO})›`),
  rx(`‹(?:is|are|was|were|has\\s+been|have\\s+been|ble|er|har\\s+blitt)\\s+(?:now\\s+|already\\s+|allerede\\s+|nå\\s+)?(?:${STATE_PARTICIPLES})›`),
  rx('^[\\s>*_~-]*(?:done|finished|completed|ferdig|fullført|✅|✓|✔)(?:[:!.\\s-]|$)'),
  rx('‹(?:all\\s+done|already\\s+done|allerede\\s+gjort|ferdig\\s+med)›'),
]

export const NEGATION = rx(`‹(?:i\\s+won['’]?t|i\\s+will\\s+not|i['’]?m\\s+not\\s+going\\s+to|(?:don['’]?t|do\\s+not|doesn['’]?t|does\\s+not|didn['’]?t)\\s+(?:need|have|want)\\s+to|(?:don['’]?t|do\\s+not)\\s+(?:send|call|do|book|buy|email)|no\\s+need\\s+to|needn['’]?t|not\\s+going\\s+to|never|cancel(?:l?ed)|skip|(?:skal|vil|kan|må|bør)\\s+ikke|trenger\\s+ikke|trenger\\s+det\\s+ikke|behøver\\s+ikke|kommer\\s+ikke|vil\\s+ikke|ikke\\s+nødvendig|ikke\\s+lenger|ikke\\s+send|avlyst|avlyste|dropp\\w*)›`)
export const HYPOTHETICAL = rx(`‹(?:if(?!\\s+(?:possible|needed|necessary|any))|maybe|perhaps|might|could\\s+(?:we|maybe|perhaps)|what\\s+if|in\\s+case|unless|would\\s+be\\s+nice|wish|hvis(?!\\s+(?:mulig|nødvendig))|dersom|om\\s+(?:vi|du|jeg|det|noen|han|hun|de)|kanskje|muligens|kunne\\s+vi|hva\\s+om|ville\\s+vært|burde\\s+kanskje|i\\s+tilfelle|med\\s+mindre)›`)

export const TODO_MARKER = rx('^[\\s>*_~-]*(?:to-?do|to\\s+do|action(?:\\s+items?)?|gjøremål|oppgave|aksjon|task|fixme)\\s*[:\\-–]', 'iu')

// [pattern, weight, strong first-person commitment]
export const FIRST_PERSON = [
  [rx('‹(?:i[\'’]ll|i\\s+will|i[\'’]m\\s+(?:also\\s+|just\\s+|still\\s+)?going\\s+to|i\\s+am\\s+going\\s+to|i[\'’]m\\s+gonna|i\\s+promise(?:\\s+to)?|i\\s+promised|i\\s+said\\s+(?:that\\s+)?i\\s+would|i\\s+told\\s+\\p{L}+\\s+i\\s+would|jeg\\s+lovet|jeg\\s+sa\\s+(?:at\\s+)?jeg\\s+skulle|(?:skal|ringer|sender|sjekker|tar|fikser|bestiller|booker|kontakter|purrer|ordner)\\s+jeg|let\\s+me\\s+(?!know|think|see|say|ask)|jeg\\s+skal|jeg\\s+kommer\\s+til\\s+å|jeg\\s+lover|jeg\\s+(?:fikser|ordner|sender|ringer|sjekker|booker|bestiller|skriver)|la\\s+meg\\s+(?!vite|tenke|se|si))'), 0.65],
  [rx('‹(?:jeg\\s+tar\\s+(?:over|på\\s+meg|det))›'), 0.4],
  [rx('‹(?:we[\'’]ll|we\\s+will|we[\'’]re\\s+going\\s+to|vi\\s+skal|vi\\s+tar\\s+(?:det|ansvar))›'), 0.12],
]
export const FIRST_PERSON_OBLIGATION = rx('‹(?:i\\s+(?:need\\s+to|have\\s+to|must|gotta|got\\s+to|have\\s+got\\s+to)|i[\'’]ve\\s+got\\s+to|jeg\\s+(?:må|trenger\\s+å)|må\\s+jeg)›')
export const FIRST_PERSON_WEAK = rx('‹(?:i\\s+(?:should|ought\\s+to)|we\\s+(?:should|ought\\s+to)|jeg\\s+(?:bør|burde)|vi\\s+(?:bør|burde))›')
export const OBLIGATION = [
  [rx('‹(?:remember\\s+to|don[\'’]?t\\s+forget|do\\s+not\\s+forget|make\\s+sure|need(?:s)?\\s+to|has\\s+to|have\\s+to|got\\s+to|gotta|must|required\\s+to|supposed\\s+to|husk\\s+(?:på\\s+)?å|husk\\s+at|glem\\s+ikke|ikke\\s+glem|sørg\\s+for|må|trenger\\s+å|nødt\\s+til)›'), 0.5],
  [rx('‹(?:should|ought\\s+to|bør|burde)›'), 0.1],
]

const IMPERATIVE_VERBS = words([
  'send', 'call', 'email', 'e-mail', 'book', 'buy', 'fix', 'review', 'write', 'ask', 'schedule', 'prepare', 'text', 'message',
  'ping', 'order', 'pay', 'update', 'draft', 'finalize', 'finalise', 'finish', 'complete', 'submit', 'upload', 'share',
  'forward', 'follow\\s+up', 'check', 'confirm', 'remind', 'contact', 'arrange', 'organi[sz]e', 'create', 'set\\s+up', 'reply', 'meet', 'møt',
  'respond', 'add', 'print', 'sign', 'renew', 'register', 'invite', 'plan', 'pick\\s+up', 'drop\\s+off', 'look\\s+into',
  'find', 'get\\s+back\\s+to', 'cancel', 'research', 'sort\\s+out', 'figure\\s+out', 'clean', 'return', 'deliver', 'ring',
  'bestill', 'kjøp', 'fiks', 'skriv', 'spør', 'ordne', 'lag', 'sjekk', 'avtal', 'planlegg', 'forbered', 'gå\\s+gjennom',
  'les', 'oppdater', 'betal', 'ta\\s+kontakt', 'kontakt', 'bekreft', 'svar', 'send\\s+inn', 'lever', 'undersøk', 'finn',
  'hent', 'rydd', 'skriv\\s+ut', 'signer', 'forny', 'meld', 'inviter', 'ferdigstill', 'avklar', 'følg\\s+opp', 'minn',
  'legg\\s+til', 'kall\\s+inn', 'mail', 'book', 'kontakt', 'last\\s+opp', 'videresend', 'sett\\s+opp', 'ta\\s+med',
])
export const IMPERATIVE = rx(`^[\\s>*_~"'“«(\\[-]*(?:@\\S+\\s+)*(?:(?:please|pls|vennligst|then|and|also|og|så|deretter|først|husk\\s+å)\\s+)*(?:${IMPERATIVE_VERBS})›`)

export const WAITING = rx('‹(?:(?:still\\s+)?(?:waiting|awaiting)|pending\\s+(?:from|on)|(?:fortsatt\\s+)?venter|avventer)›')
export const WAITING_NAMED = rx('‹(?:(?:still\\s+)?(?:waiting|awaiting)(?:\\s+(?:for|on))?|venter(?:\\s+på)?|avventer)\\s+(?:(?:at|that)\\s+)?(\\p{L}[\\p{L}\'’-]+(?:\\s+\\p{L}[\\p{L}\'’-]+)?)', 'iu')
export const WILL_DO = rx('(?<![\\p{L}\\p{N}_])(\\p{L}[\\p{L}\'’-]*?)(?:\\s+(?:will|is\\s+going\\s+to|promised\\s+to|said\\s+(?:he|she|they)\\s+would|skal|kommer\\s+til\\s+å|lovet\\s+å|lover\\s+å)|[\'’]ll)\\s+(?:send|email|mail|get\\s+back|reply|respond|let|give|share|forward|come\\s+back|call|ring|deliver|check|fix|sende|svare|gi|dele|komme|levere|ringe|melde|gjøre|fikse|ordne|sjekke|bestille|booke|undersøke|finne|skrive|ta)(?![\\p{L}\\p{N}_])([^.!?]*)')
export const TO_ME = rx('‹(?:me|us|meg|oss)›')
export const PRONOUNS = new Set(['he', 'she', 'they', 'han', 'hun', 'de'])

export const FOLLOW_UP = rx('‹(?:follow(?:ing)?[\\s-]*up|ping\\s+(?:him|her|them)|nudge|(?:need|have)\\s+to\\s+(?:talk|speak)\\s+(?:to|with)|(?:må|bør|skal)\\s+(?:vi|jeg)\\s+(?:snakke|prate)\\s+med|check\\s+back|circle\\s+back|touch\\s+base|get\\s+back\\s+to|remind\\s+(?:me|\\p{L}+)\\s+(?:to|about)|følge\\s+opp|følg\\s+opp|følger\\s+opp|sjekke\\s+med|sjekk\\s+med|høre\\s+med|hør\\s+med|ta\\s+kontakt\\s+igjen|komme\\s+tilbake\\s+til|purre|pur\\s+på|minne\\s+(?:på|om))›')
export const EVENT = rx('‹(?:meeting|appointment|lunch|dinner|interview|workshop|stand-?up|demo|webinar|conference|presentation|dentist|doctor|flight|(?:zoom|teams|phone|video|conference)\\s+call|call\\s+with|møte|møtet|avtale|avtalen|lunsj|middag|intervju|frokost|kurs|konferanse|presentasjon|tannlege|tannlegen|legetime|flyet|samtale\\s+med)›')
export const EVENT_WITH = rx('‹(?:meeting|appointment|lunch|dinner|interview|workshop|demo|call|møte|møtet|avtale|avtalen|lunsj|middag|intervju|samtale)\\s+(?:with|med)\\s+\\p{L}')
export const FIRST_PERSON_PRONOUN = rx('‹(?:I|[Ww]e|[Yy]ou|[Jj]eg|[Vv]i|[Dd]u|[Dd]ere)›', 'u')
export const HISTORY_YEAR = /(?<![\d.])(?:1\d{3}|20[01]\d)(?![\d])/
export const PAST_STATE = rx('‹(?:was|were|had|went|var|hadde|gikk)›')
export const REQUEST = [
  rx('‹(?:(?:can|could|would|will)\\s+you(?:\\s+please)?|(?:kan|kunne|vil|ville)\\s+(?:du|dere)(?:\\s+(?:være\\s+så\\s+snill\\s+å|vennligst))?|would\\s+you\\s+mind)›'),
  rx('‹(?:ask|tell|remind|get)\\s+(?:\\p{L}[\\p{L}\'’-]+)\\s+to›'),
  rx('‹(?:spør|ber|minn|si\\s+til)\\s+(?:\\p{L}[\\p{L}\'’-]+)\\s+(?:om\\s+å|om|å|at)›'),
  rx('‹(?:you\\s+(?:need|have|must|should|will)\\s+to?|you[\'’]ll|du\\s+(?:må|skal|bør)|dere\\s+(?:må|skal|bør))›'),
]

export const PERSON_AFTER = rx('‹(?:to|with|from|for|ask|tell|email|call|text|ping|remind|meet|cc|send|til|med|fra|spør|ring|ringe|møte|minn|sende|opp|kontakt|hos)\\s+(?=(\\p{L}[\\p{L}\'’-]+(?:\\s+\\p{L}[\\p{L}\'’-]+)?))', 'giu')
export const MENTION = /(?<![\p{L}\p{N}_@])@(\p{L}[\p{L}\p{N}_.-]*)/u
export const BE_CASUAL = rx('‹(?:i[\'’]ll|i\\s+will|jeg\\s+skal)\\s+(?:probably\\s+|nok\\s+)?(?:be|think|see|say|være|tenke|se)›')
export const NAME_STOP = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'his', 'her', 'their', 'its', 'it', 'i', 'we', 'you',
  'he', 'she', 'they', 'me', 'us', 'him', 'them', 'all', 'some', 'any', 'each', 'every', 'det', 'den', 'de', 'dette', 'en', 'et',
  'vi', 'jeg', 'du', 'dere', 'han', 'hun', 'meg', 'oss', 'min', 'mitt', 'vår', 'vårt', 'din', 'ditt', 'hans', 'hennes', 'alle',
  'noen', 'hver', 'next', 'last', 'neste', 'forrige', 'kommende', 'tomorrow', 'today', 'yesterday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag', 'january',
  'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'januar',
  'februar', 'mars', 'mai', 'juni', 'juli', 'oktober', 'desember', 'easter', 'christmas', 'påske', 'jul', 'week', 'uke', 'month',
  'måned', 'noon', 'midnight', 'still', 'also', 'okay', 'ok', 'right', 'and', 'but', 'so', 'og', 'så', 'fortsatt', 'også', 'nå', 'now', 'just', 'bare', 'at', 'on', 'in', 'by', 'kl', 'på', 'om', 'innen', 'før', 'senest', 'til',
])

export const VOCATIVE = /^\s*(\p{Lu}[\p{L}'’-]+),\s/u
export const SUBJECT_NAME = /^\s*(\p{Lu}[\p{L}'’-]+)\s+(?:asked|told|said|wants?|needs?|wanted|sa|spurte|ba|ber|vil|ville|mener)(?![\p{L}\p{N}_])/u
export const THIRD_PARTY_BEFORE = /(?:^|[\s,;(])(\p{Lu}[\p{L}'’-]*|he|she|they|han|hun|de)(?:\s+(?:is|are|was|er|var)|['’]s|['’]re)?\s*(?:still\s+|fortsatt\s+)?$/u
export const INFINITIVE = rx(`^[\\s>*_~-]*(?:bestille|kjøpe|sende|ringe|levere|booke|skrive|sjekke|fikse|ordne|betale|hente|lage|spørre|kontakte|følge\\s+opp|forberede|oppdatere|avtale|planlegge|svare|bekrefte|undersøke|finne|rydde|vaske|handle|ta\\s+kontakt|ta\\s+med|melde|booke)›`)
export const CONTINGENT = rx(`‹(?:if\\s+(?:nothing|not|no\\b|it\\s+(?:doesn|does\\s+not|hasn|has\\s+not|isn)|he\\s+(?:doesn|hasn)|she\\s+(?:doesn|hasn)|they\\s+(?:don|haven)|there\\s+(?:is|are|was|were)\\s+no\\b)|unless|hvis\\s+(?:ikke|ingenting|ingen)|dersom\\s+ikke|om\\s+ikke)`)
export const COOKING = rx('‹(?:stir|whisk|bake|simmer|boil|knead|preheat|fold\\s+in|tablespoons?|teaspoons?|cups?|grams?|until\\s+(?:smooth|golden|tender|combined)|rør|visp|stek|kok|ha\\s+i|dl|ss|ts|spiseskje|teskje|ovnen)›')
export const WE_OBLIGATION = rx('‹(?:(?:we|vi)\\s+(?:need\\s+to|have\\s+to|must|should|må|bør)|må\\s+vi)›')
export const EVENT_VERB = rx('‹(?:is|are|will\\s+be|starts?|begins?|arrives?|comes?|er|blir|kommer|starter|begynner|skjer|ankommer)›')
