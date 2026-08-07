# OmniFocus URL Scheme Skill

Den här filen sammanfattar hur OmniFocus URL-schemat ska användas i detta repo.
Källa: https://inside.omnifocus.com/url-schemes

## Syfte i det här projektet

Pluginet ska skapa nya tasks i OmniFocus från Obsidian-tasks.

För V1 ska vi skapa tasks i Inbox genom att:

- sätta task-raden som `name`
- sätta taskens indenterade underrader plus Obsidian-backlink som `note`
- inte skicka någon `project`-parameter

Så länge `project` inte anges ska uppgiften hamna i Inbox enligt projektets beslut.

## Grundformat

Basformat för att skapa en task är:

```text
omnifocus:///add?name=TASK_TITLE&note=TASK_NOTE
```

Exempel från OmniFocus-dokumentationen:

```text
omnifocus:///add?name=Pick%20up%20milk&note=You%20gotta
```

Detta betyder:

- `add` skapar en ny uppgift i OmniFocus
- `name` är uppgiftens titel
- `note` är uppgiftens anteckning

## Inbox-beteende

För det här pluginet vill vi skapa i Inbox.

Arbetsregel för implementationen:

- skicka `name`
- skicka `note`
- skicka inte `project`

Om vi senare skickar `project` kommer OmniFocus försöka matcha projektet case-insensitivt och lägga uppgiften där i stället.

## Parametrar som är relevanta för oss

De viktigaste parametrarna från dokumentationen är:

- `name`: titel på tasken
- `note`: note-fältet i OmniFocus
- `project`: case-insensitive projektnamn, ska utelämnas i V1
- `flag`: `true` eller `false`
- `defer`: datum/tid, exempel `jun 25 8am`
- `due`: datum/tid, exempel `jun 25 8am`
- `estimate`: exempel `30m`
- `completed`: datum/tid om objektet ska skapas som klart
- `reveal-new-item`: `true` eller `false`

Det finns fler parametrar i OmniFocus-dokumentationen, men ovanstående räcker för detta plugin i nuläget.

## URL-kodning

Parametrar sätts ihop med `&`.

Exempel:

```text
omnifocus:///add?name=Buy%20coffee&note=Line%201%0ALine%202%0A%0Aobsidian%3A%2F%2Fopen%3Fvault%3DMyVault%26file%3DNotes%252FMeetings.md
```

Viktigt för implementationen:

- mellanslag måste URL-kodas, vanligtvis som `%20`
- radbrytningar i `note` bör URL-kodas som `%0A`
- specialtecken i backlinken måste URL-kodas
- hela `name`- och `note`-värdet ska behandlas som användardata och kodas innan URL byggs

I pluginet bör detta göras med standardkodning per parameter, till exempel `encodeURIComponent(...)`.

## Rekommenderat V1-flöde

För varje ej klar Obsidian-task:

1. Läs första task-raden som titel.
2. Samla alla indenterade underrader som note-text.
3. Generera Obsidian-backlink till källnoten.
4. Bygg note-innehållet som användaranteckningar följt av backlink.
5. URL-koda `name` och `note`.
6. Bygg `omnifocus:///add?...` utan `project`.
7. Öppna URL:en från pluginet.

## Implementerad V1-synk i pluginet

Nuvarande implementation i pluginet gör följande:

- scannar hela valvet
- parser tasks till ett internt OmniFocus-format
- deduplikerar mot både aktuell scan och pluginets lokala exportregister
- bygger OmniFocus-URL med `name` och `note`
- öppnar `omnifocus:///add?...` för varje återstående task
- sparar exportpost lokalt bara när URL-öppningen inte misslyckas lokalt

URL:en byggs från pluginet med parameterkodning motsvarande:

```text
omnifocus:///add?name=...&note=...
```

## Känd begränsning i utvecklingsmiljön

Koden bygger och typkontrollerar, men runtime-beteendet mot OmniFocus kunde inte verifieras i denna Linux-baserade utvecklingsmiljö.

Det som återstår att verifiera på macOS med OmniFocus installerat är:

- att `window.open("omnifocus:///add?...", "_blank")` faktiskt triggar OmniFocus som väntat i Obsidian desktop
- att flera exporter i följd fungerar stabilt
- att URL-öppning som lyckas lokalt motsvarar att uppgiften verkligen skapats i OmniFocus

## Runtime-guard i pluginet

Nuvarande plugin stoppar exporten tidigt med ett tydligt felmeddelande om någon av dessa förutsättningar saknas:

- Obsidian kör inte som desktop-app
- miljön är inte macOS
- `window.open` saknas och URL-schemat kan därför inte öppnas

Det gör att användaren får ett begripligt fel innan några exportposter sparas lokalt.

## Backlink-beslut i V1

Första implementationen ska använda fil-baserad Obsidian-länk:

```text
obsidian://open?vault=VAULT_NAME&file=FILE_PATH
```

Detta valdes för robusthet.

- länken öppnar alltid källfilen
- heading-path sparas som läsbar kontext i note-texten
- blockreferenser och heading-specifika URI-varianter skjuts upp till senare version om det behövs

## Rekommenderat note-format

Föreslagen struktur för `note`:

```text
Första notraden
Andra notraden

Obsidian: obsidian://open?... 
```

Om tasken inte har några indenterade underrader ska note-fältet ändå innehålla backlinken.

## x-callback-url

OmniFocus dokumenterar även `x-callback-url`.

Exempel från dokumentationen:

```text
omnifocus://x-callback-url/add?name=My%20shiny%20new%20task&autosave=true&x-success=[source-app]:///
```

Detta kan användas senare om vi vill få en callback med en direktlänk till den skapade OmniFocus-tasken.

Det är inte nödvändigt för V1 eftersom vårt dedupe-spårning i första versionen ska ligga i pluginets lokala data, inte i OmniFocus-ID:n.

## Paste-alternativet

OmniFocus stöder även:

```text
omnifocus:///paste
```

och `target`-parametrar för TaskPaper-baserad import.

Detta är inte förstahandsvalet för V1 eftersom vårt behov är enklare:

- en task per Obsidian-task
- explicit titel
- explicit note
- Inbox som standardmål

`add` är därför den enklaste och mest förutsägbara integrationsvägen.

## Begränsningar och försiktighet

- URL-parametrarna måste vara korrekt kodade, annars riskerar text att kapas eller tolkas fel.
- Om `project` börjar användas senare beror placeringen på OmniFocus matchning av projektnamn.
- Dokumentationen visar att flera parametrar stöds, men V1 bör hålla sig till minsta möjliga uppsättning: `name` och `note`.
- `x-callback-url` kan vara användbart senare men ska inte vara ett krav för första implementationen.

## Deduplikering i V1

Pluginet ska hålla dedupe lokalt i pluginets datafil.

Fingerprint-strategin i V1 är:

- normaliserad källsökväg
- radnummer
- heading-path
- normaliserad tasktitel
- normaliserad rå note-text från Obsidian-tasken

Det betyder att backlinken i OmniFocus-note inte används som fingerprint-underlag. Det är avsiktligt, så att ändringar i backlink-format eller vault-namn inte i sig skapar nya fingerprints.

Praktisk konsekvens i V1:

- om en task redan exporterats med samma fingerprint ska den hoppas över
- om samma fingerprint förekommer flera gånger i samma scan behandlas bara en av dem som kandidat
- om titel, note, fil, heading-path eller radnummer ändras efter tidigare export får tasken en ny fingerprint och behandlas som en ny exportkandidat

## Beslut för implementationen

För det här repot gäller följande tills vidare:

- använd `omnifocus:///add`
- skicka alltid `name`
- skicka alltid `note`
- skicka inte `project` i V1
- förlita dig på att frånvaro av `project` betyder Inbox för V1-flödet
- håll dedupe lokalt i pluginets data i stället för att kräva callback eller OmniFocus-ID