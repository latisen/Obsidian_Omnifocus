# Obsidian_Omnifocus

Projektplanen finns i [PROJECT_PLAN.md](PROJECT_PLAN.md) och används som vår checklista för implementationen.

## Mål

Bygga ett Obsidian-plugin som hittar alla ej färdigmarkerade tasks i valvet och skapar motsvarande uppgifter i OmniFocus Inbox utan dubletter.

## Datumfält i tasks

Pluginet stödjer nu inline-fälten `planned::` och `due::` i Obsidian-tasks.

Exempel:

```md
- [ ] Skicka statusrapport planned::2026-08-10 due::2026-08-12
```

- `planned::` mappas till OmniFocus `defer date` (planerat datum).
- `due::` mappas till OmniFocus `due date`.
- Fälten används både vid skapande av nya tasks och i tvåvägssynken.