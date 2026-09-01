# Cas d’usage de référence

Ce document décrit les cas d’usage que l’architecture de Snoopit doit continuer à supporter.

Ils servent de tests de cohérence lors des évolutions du produit.

## 1. Veille d’un site source

Objectif :

> Visiter régulièrement un site de référence et identifier les nouvelles publications depuis le run précédent.

Le workflow doit pouvoir :

* parcourir seulement une partie du site à chaque run ;
* mémoriser les URLs déjà vues ;
* identifier les nouvelles ressources ;
* détecter des changements ;
* télécharger les nouveaux documents ;
* produire un rapport de visite ;
* reprendre après interruption.

Exemples :

```text
site institutionnel
site réglementaire
site fournisseur
documentation technique
site statistique
```

## 2. Collecte de documents pour un RAG

Objectif :

> Récupérer automatiquement des documents qui deviendront ensuite des sources d’un système de RAG ou de gestion de connaissances.

Le workflow doit produire :

```text
contenu
fichier original
URL source
date de collecte
first_seen_at
last_seen_at
content_hash
metadata
```

Snoopit ne réalise pas lui-même l’indexation vectorielle.

Il remet les artifacts à un pipeline d’ingestion externe.

## 3. Suivi d’annonces immobilières

Objectif :

> Visiter régulièrement les recherches enregistrées d’un portail immobilier et conserver l’évolution des annonces observées.

Le système doit pouvoir détecter :

```text
nouvelle annonce
annonce déjà connue
modification
variation de prix
disparition
réapparition
```

Les informations peuvent ensuite être transmises à une mémoire externe comme 2ndBrAIn afin de permettre des analyses longitudinales ou des comparaisons entre plusieurs portails.

## 4. Récupération périodique de fichiers

Objectif :

> Automatiser la récupération d’un fichier ou dataset publié régulièrement mais difficile ou impossible à obtenir via une API stable.

Exemples :

```text
PDF
XLSX
CSV
ZIP
image
document bureautique
```

Le workflow doit conserver :

* provenance ;
* hash ;
* date de récupération ;
* relation avec les versions précédentes.

## 5. Workflow créé et maintenu par coding agent

Un coding agent doit pouvoir :

1. comprendre l’API de Snoopit ;
2. explorer un site avec les primitives disponibles ;
3. créer un workflow ;
4. tester ce workflow ;
5. le versionner ;
6. le modifier lorsque le site évolue.

Le workflow produit devient ensuite autonome et ne nécessite pas le coding agent lors de chaque run.

Principe :

```text
agent coding
    ↓
exploration
    ↓
workflow versionné
    ↓
tests
    ↓
runs autonomes
    ↓
évolution du site
    ↓
correction éventuelle par l’agent
```

## Critère de cohérence

Une évolution de Snoopit ne doit pas rendre significativement plus difficile l’un de ces cas d’usage sans décision architecturale explicite.
