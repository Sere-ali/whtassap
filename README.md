# Diffusion WhatsApp

Application web pour envoyer un même message à une liste de contacts.

## Deux modes d'envoi
1. **Liens WhatsApp** (aucune configuration) : l'appli génère un lien par contact, vous cliquez et envoyez depuis votre propre WhatsApp.
2. **API WhatsApp Cloud (Meta)** : envoi automatique. Nécessite un compte Meta Business, un `WHATSAPP_TOKEN` et un `WHATSAPP_PHONE_NUMBER_ID`.
   Pour écrire à des personnes qui ne vous ont pas écrit dans les dernières 24 h, il faut un **modèle de message approuvé** par Meta.

> WhatsApp ne permet pas de créer un « groupe » automatiquement par programme : l'appli envoie un message individuel à chaque contact.

## Déploiement sur Render
1. Poussez ce dossier sur un dépôt GitHub.
2. Render > New > Blueprint (ou Web Service), choisissez le dépôt (`render.yaml` est détecté).
3. Renseignez les variables : `APP_PASSWORD` (obligatoire), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (optionnelles pour le mode liens).
4. Ouvrez l'URL fournie, entrez le mot de passe.

Test local : `npm install && APP_PASSWORD=test npm start` puis http://localhost:3000
