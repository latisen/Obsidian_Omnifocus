# Testguide: Fas 8

Den här guiden är till för manuell testning av pluginet i Obsidian Desktop på macOS.

## Förutsättningar

- Obsidian Desktop installerat.
- OmniFocus installerat på samma Mac.
- Plugin-repot ligger i plugin-katalogen för ett vault, helst:
  `.obsidian/plugins/obsidian-omnifocus/`
- Community Plugins är aktiverat i Obsidian.

## Bygg pluginet

Kör i plugin-mappen:

```bash
npm install
npm run build
```

Om du redan har installerat beroenden räcker det med:

```bash
npm run build
```

## Ladda pluginet i Obsidian

1. Öppna Obsidian.
2. Gå till `Settings -> Community plugins`.
3. Om pluginet inte syns: stäng och öppna vaultet igen eller välj att reloada Obsidian.
4. Aktivera `Obsidian OmniFocus`.
5. Gå till pluginets settings.
6. Låt `Dry run` vara påslaget för de första testerna.

## Testkommandon

Pluginet använder dessa kommandon:

- `Sync unfinished tasks to OmniFocus Inbox`
- `Clear exported task cache`

Öppna Command Palette i Obsidian och kör kommandona därifrån.

## Rekommenderad testordning

1. Kör först alla parser- och preview-tester med `Dry run = ON`.
2. När resultatet ser rätt ut, slå av `Dry run`.
3. Kör export mot OmniFocus.
4. Bekräfta att Inbox får rätt titel, note och backlink.
5. Kör om synken för att verifiera deduplikering.

## Testdata

Skapa följande filer i ditt test-vault.

### 1. Enkel task på en rad

Fil: `Phase8-Test-01.md`

```md
- [ ] Buy oat milk
```

Förväntat resultat:

- Pluginet hittar 1 ej klar task.
- Taskens titel blir `Buy oat milk`.
- OmniFocus-note innehåller minst Obsidian-backlinken.

### 2. Task med flera indenterade noterader

Fil: `Phase8-Test-02.md`

```md
- [ ] Prepare weekly review
  Check previous action list
  Bring notes from meeting
  Confirm next milestones
```

Förväntat resultat:

- Pluginet hittar 1 ej klar task.
- Titeln blir `Prepare weekly review`.
- Note-fältet i OmniFocus innehåller de tre indenterade raderna i samma ordning.
- Backlinken läggs till under notraderna.

### 3. Tasks i flera filer

Fil: `Phase8-Test-03-A.md`

```md
- [ ] Review budget
```

Fil: `Phase8-Test-03-B.md`

```md
- [ ] Book travel
```

Förväntat resultat:

- Pluginet hittar båda tasksen över flera filer.
- Båda kan exporteras.
- Varje note innehåller backlink till rätt fil.

### 4. Likadana tasktitlar i olika filer

Fil: `Phase8-Test-04-A.md`

```md
- [ ] Follow up with Alex
```

Fil: `Phase8-Test-04-B.md`

```md
- [ ] Follow up with Alex
```

Förväntat resultat:

- Båda tasksen ska behandlas som separata om de ligger i olika filer.
- De ska inte kollapsa till en enda export bara för att titeln är samma.
- Varje exporterad task ska få backlink till rätt källa.

### 5. Färdigmarkerade tasks ignoreras

Fil: `Phase8-Test-05.md`

```md
- [x] Already done
- [ ] Still open
```

Förväntat resultat:

- Endast `Still open` ska behandlas som exportkandidat.
- `Already done` ska ignoreras helt.

### 6. Samma synk ska inte skapa dubletter

Använd en tidigare testfil, till exempel:

```md
- [ ] Buy oat milk
```

Förväntat resultat:

1. Första skarpa synken skapar tasken i OmniFocus.
2. Andra skarpa synken, utan ändring i filen, ska inte skapa en ny kopia.
3. Pluginets sammanfattning ska visa att tasken redan är känd eller skippad.

### 7. Ändrade tasks efter tidigare export

Utgå från en task som redan exporterats:

```md
- [ ] Buy oat milk
```

Ändra sedan till:

```md
- [ ] Buy oat milk and yogurt
  Organic if available
```

Förväntat resultat i V1:

- Den ändrade tasken får nytt fingerprint.
- Pluginet behandlar den som en ny exportkandidat.
- Det innebär att en ny OmniFocus-task kan skapas.
- Detta är känt och avsiktligt i V1.

## Praktiskt testflöde för första körningen

1. Säkerställ att `Dry run` är på.
2. Lägg in endast `Phase8-Test-01.md` i vaultet.
3. Kör `Sync unfinished tasks to OmniFocus Inbox`.
4. Bekräfta att sammanfattningen visar 1 pending export.
5. Slå av `Dry run`.
6. Kör synken igen.
7. Bekräfta att OmniFocus Inbox får en task med rätt titel och en note som innehåller backlink.
8. Bekräfta att ingen OmniFocus-bekräftelsedialog visas under skapandet.
9. Kör synken en tredje gång utan att ändra filen.
10. Bekräfta att ingen dubblett skapas.

## Vad du bör rapportera tillbaka efter varje test

Skicka gärna tillbaka följande efter varje punkt:

- vilken testfil du körde
- om `Dry run` var på eller av
- vad Obsidian visade i sammanfattningen
- vad OmniFocus faktiskt skapade
- om backlinken fungerade
- om något avvek från förväntat resultat