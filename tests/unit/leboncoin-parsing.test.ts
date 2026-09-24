import { describe, expect, it } from 'vitest';
import {
  mergeAds,
  parseAdCard,
  parseResultCount,
  savedSearchId,
  searchIdentityUrl,
  type RawAdCard,
} from '../../workflows/leboncoin-recherches.js';

const ID = 'e73082b7-f4f3-4957-af30-ac8508ac3dcc';

const card = (overrides: Partial<RawAdCard> = {}): RawAdCard => ({
  url: `https://www.leboncoin.fr/ad/ventes_immobilieres/3190549143?saved_id_view=${ID}`,
  libelle: 'Voir l’annonce: Maison · 5 pièces · 133m²',
  texte:
    '339 000 € Prix: 339 000 €. Maison · 5 pièces · 133m² Terrain : 5966 m² ' +
    'Surface du terrain 5966 mètres carrés La Ferté 77260 Située à La Ferté 77260. ' +
    'Vendeur professionnel.',
  vendeur: 'Agence',
  mention: 'Annonce proposée par Agence, publiée aujourd’hui à 14:33, voir sa page professionnel',
  photos: 'Passer à la photo 1 sur 5',
  ...overrides,
});

describe('savedSearchId / searchIdentityUrl', () => {
  it('lit l’identifiant stable dans le lien de la recherche', () => {
    expect(savedSearchId(`/recherche?category=9&sa=2026-09-10T08%3A16Z&saved_id_view=${ID}`)).toBe(
      ID,
    );
    expect(savedSearchId('/recherche?category=9')).toBeNull();
  });

  it('identifie une recherche par ce seul identifiant, pas par son horodatage ni ses critères', () => {
    expect(searchIdentityUrl(ID)).toBe(`https://www.leboncoin.fr/recherche?saved_id_view=${ID}`);
  });
});

describe('parseResultCount', () => {
  it('lit le compteur masqué, espaces fines comprises', () => {
    expect(parseResultCount([null, 'Résultats de recherche : 1 234 annonces'])).toBe(1234);
    expect(parseResultCount(['Résultats de recherche : 1 annonce'])).toBe(1);
  });

  it('dit null quand la page ne donne pas de compteur', () => {
    expect(parseResultCount(['Estimez votre bien'])).toBeNull();
  });
});

describe('parseAdCard', () => {
  it('lit une carte de vendeur pro', () => {
    expect(parseAdCard(card())).toEqual({
      id: '3190549143',
      champs: {
        titre: 'Maison · 5 pièces · 133m²',
        prix: 339000,
        lieu: 'La Ferté 77260',
        terrainM2: 5966,
        vendeur: 'Agence',
        pro: true,
        baisseDePrix: false,
        photos: 5,
        url: 'https://www.leboncoin.fr/ad/ventes_immobilieres/3190549143',
      },
      publication: 'aujourd’hui à 14:33',
    });
  });

  it('garde la date relative hors des champs suivis', () => {
    expect(Object.keys(parseAdCard(card())!.champs)).not.toContain('publication');
  });

  it('lit une carte de particulier sans photos ni terrain', () => {
    const ad = parseAdCard(
      card({
        texte: 'Prix: 199 000 €. Située à Bourg 77002.',
        vendeur: null,
        mention: null,
        photos: null,
      }),
    );
    expect(ad?.champs).toMatchObject({ prix: 199000, terrainM2: null, pro: false, photos: null });
    expect(ad?.publication).toBeNull();
  });

  it('repère une baisse de prix annoncée', () => {
    expect(parseAdCard(card({ texte: 'Prix: 116 000 €.. Baisse de prix' }))?.champs).toMatchObject({
      prix: 116000,
      baisseDePrix: true,
    });
  });

  it('ignore ce qui n’est pas une annonce', () => {
    expect(parseAdCard(card({ url: '/immo/estimation?entryPoint=ad_search' }))).toBeNull();
  });
});

describe('mergeAds', () => {
  it('fusionne une annonce remontée avec son apparition complète', () => {
    const reduite = parseAdCard(card({ vendeur: null, mention: null, photos: null }))!;
    const complete = parseAdCard(card())!;
    const [merged, ...rest] = mergeAds([reduite, complete]);

    expect(rest).toEqual([]);
    expect(merged?.champs).toMatchObject({ vendeur: 'Agence', photos: 5, pro: true });
    expect(merged?.publication).toBe('aujourd’hui à 14:33');
  });

  it('garde le titre de la carte complète, que la carte réduite vienne avant ou après', () => {
    const reduite = parseAdCard(
      card({
        libelle: 'Voir l’annonce: Maison, 5 pièces, 133 mètres carrés.',
        vendeur: null,
        mention: null,
        photos: null,
      }),
    )!;
    const complete = parseAdCard(card())!;
    for (const order of [
      [reduite, complete],
      [complete, reduite],
    ]) {
      expect(mergeAds(order)[0]?.champs.titre).toBe('Maison · 5 pièces · 133m²');
    }
  });
});
