# Projektplan: Obsidian -> OmniFocus

Den här filen är arbetsplanen för projektet. Varje punkt går att checka av när den är klar.

## Produktmål

- [ ] Bygga ett Obsidian-plugin för desktop på macOS.
- [ ] Hitta alla ej färdigmarkerade Markdown-tasks i Obsidian.
- [ ] Skapa motsvarande tasks i OmniFocus Inbox.
- [ ] Undvika dubletter genom att spara vilka tasks som redan exporterats.
- [ ] Sätta task-raden som titel i OmniFocus.
- [ ] Sätta indenterade rader under tasken som note i OmniFocus.
- [ ] Lägga till en Obsidian-backlink i note-fältet i OmniFocus.

## Avgränsning för V1

- [ ] Endast manuell synk via kommando i Obsidian.
- [ ] Endast skapa nya OmniFocus-tasks, inte uppdatera eller radera befintliga.
- [ ] Endast stöd för Obsidian desktop på macOS.
- [ ] Endast export av tasks som inte är markerade som klara.

## Beslut låsta hittills

- [x] V1 ska scanna hela valvet.
- [x] Integration mot OmniFocus ska använda OmniFocus Advanced URI.
- [x] Obsidian-backlink i OmniFocus note är ett fungerande arbetssätt.
- [x] Om inget projekt anges vid skapande ska uppgiften landa i OmniFocus Inbox.
- [x] Faktisk exportimplementation i pluginet använder AppleScript för att undvika OmniFocus bekräftelsedialog via URL-schemat.

## Fas 1: Beslut och teknisk verifiering

- [x] Bestäm exakt synkomfång för V1.
  Beslut: hela valvet scannas i V1.
- [x] Bekräfta vilken integration som ska användas mot OmniFocus.
  Beslut: OmniFocus Advanced URI används i V1.
- [x] Verifiera att vald URL/URI-integrationsväg kan skapa Inbox-task med både titel och note.
  Bekräftat via OmniFocus dokumentation: `omnifocus:///add?name=...&note=...`.
- [x] Verifiera att en Obsidian-backlink kan inkluderas i note-fältet.
  Bekräftat av användaren som redan gör detta manuellt idag.
- [x] Dokumentera eventuella begränsningar i OmniFocus-API eller URL-scheme.
  Dokumenterat i `Omnifocus-skill.md`.

Notering efter senare verifiering: URL-schemat fungerade men visade bekräftelsedialog vid skapande. Pluginets exportväg har därför ändrats till AppleScript på macOS, medan URL-schemat fortfarande finns dokumenterat som referens.

## Fas 2: Grundprojekt och scaffolding

- [x] Skapa pluginstruktur för Obsidian.
- [x] Lägg till manifest, TypeScript-konfiguration och buildflöde.
- [x] Skapa huvudklass för pluginet.
- [x] Lägg till kommando för manuell synk.
- [x] Lägg till persistering för plugin-data och settings.

## Fas 3: Parsing av Obsidian-tasks

- [x] Skanna Markdown-filer i valvet.
- [x] Identifiera tasks i format som Obsidian känner igen.
- [x] Filtrera bort tasks som redan är färdigmarkerade.
- [x] Tolka taskens första rad som OmniFocus-titel.
- [x] Samla indenterade underrader som task-note.
- [x] Bevara radbrytningar i note-innehållet.
- [x] Samla källmetadata: fil, eventuell heading, radnummer eller motsvarande referens.

## Fas 4: Backlinks och task-representation

- [x] Generera Obsidian-länk till källnoten.
- [x] Avgör om länken ska gå till fil, heading eller blockreferens.
  Beslut i V1: använd fil-länk för robusthet, och lägg heading-path i note-texten som läsbar kontext.
- [x] Bygg note-innehållet så att användaranteckningar och backlink samexisterar tydligt.
- [x] Definiera ett internt dataformat för exporterbara tasks.

## Fas 5: Deduplikering

- [x] Definiera fingerprint-strategi för att känna igen redan exporterade tasks.
- [x] Förslag på fingerprint: normaliserad sökväg + tasktext + note-text + stabil referens om tillgänglig.
  Implementerat i V1 som: normaliserad sökväg + radnummer + heading-path + tasktitel + rå note-text.
- [x] Spara exporterade tasks i pluginets lokala datafil.
- [x] Kontrollera före export om tasken redan finns i lokalt register.
- [x] Dokumentera hur ändrade tasks hanteras i V1.
  V1-regel: om titel, note, fil, heading-path eller radnummer ändras blir fingerprinten ny och tasken behandlas som ej exporterad.

## Fas 6: Synkmotor

- [x] Implementera flöde för full scanning av valvet.
- [x] Bygg lista över exporterbara tasks.
- [x] Skippa tasks som redan exporterats.
- [x] Skapa återstående tasks i OmniFocus Inbox.
- [x] Spara resultat endast för exports som verkligen lyckades.
- [x] Visa sammanfattning efter körning: skapade, skippade, fel.
- [x] Lägg till enkel felhantering för misslyckad export.

## Fas 7: Settings och driftbarhet

- [x] Lägg till settings för vault-namn om det behövs för backlinks.
- [x] Lägg till settings för inkluderade eller exkluderade mappar.
- [x] Lägg till dry-run-läge för testning utan export.
- [x] Lägg till kommando för att rensa dedupe-cache.
- [x] Lägg till logik för tydliga felmeddelanden när OmniFocus inte är tillgängligt.

## Fas 8: Testning

- [ ] Testa enkel task på en rad.
- [ ] Testa task med flera indenterade noterader.
- [ ] Testa tasks i flera filer.
- [ ] Testa likadana tasktitlar i olika filer.
- [ ] Testa att färdigmarkerade tasks ignoreras.
- [ ] Testa att samma synk inte skapar dubletter.
- [ ] Testa hur ändrade tasks beter sig efter tidigare export.

## Fas 9: Dokumentation och releaseförberedelse

- [ ] Dokumentera installation och utvecklingsmiljö.
- [ ] Dokumentera macOS-krav och OmniFocus-beroenden.
- [ ] Dokumentera kända begränsningar i V1.
- [ ] Dokumentera hur användaren kör synk och återställer cache.
- [ ] Förbered repot för fortsatt stegvis implementation.

## Föreslagen exekveringsordning

- [ ] Steg 1: Skapa pluginets grundstruktur.
- [ ] Steg 2: Bygg en minimal OmniFocus-export som teknisk spike.
- [ ] Steg 3: Implementera parsing av tasks från Markdown.
- [ ] Steg 4: Lägg till backlink-generering och note-formattering.
- [ ] Steg 5: Implementera deduplikering och lokal lagring.
- [ ] Steg 6: Koppla ihop allt i ett manuellt synkkommando.
- [ ] Steg 7: Lägg till settings, dry-run och cache-rensning.
- [ ] Steg 8: Testa med riktiga exempel och justera beteende.
- [ ] Steg 9: Dokumentera användning och begränsningar.

## Definition of done för V1

- [ ] En manuell synk i Obsidian skapar Inbox-tasks i OmniFocus för alla ej klara tasks inom valt scope.
- [ ] Varje exporterad task får rätt titel och rätt note-innehåll.
- [ ] Note-innehållet innehåller en fungerande Obsidian-backlink.
- [ ] En andra synk utan innehållsändringar skapar inga dubletter.
- [ ] Projektet går att bygga, testa och fortsätta utveckla från detta repo.