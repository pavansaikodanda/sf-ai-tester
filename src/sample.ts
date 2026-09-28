export const SAMPLE_SUITE = `# SF AI Tester suite. Each case needs: id, title, steps, expected.
# Optional per case: description, preconditions, data, tags, mode (manual | automation | both).
name: Sales Cloud smoke
context: >
  Standard Sales Cloud org in Lightning Experience. The test user has the System Administrator profile.

cases:
  - id: ACC-001
    title: Create a new Account
    preconditions:
      - User can create Accounts
    steps:
      - Open the Accounts tab
      - Click New
      - Enter Account Name "AI-TEST Acme {unique}" and Phone "0123456789"
      - Save the record
    expected:
      - A success toast confirms the Account was created
      - The Account detail page shows the entered name and phone

  - id: OPP-001
    title: Opportunity requires Close Date and Stage
    steps:
      - Open the Opportunities tab and click New
      - Enter only an Opportunity Name and click Save
    expected:
      - The record is not saved
      - Close Date and Stage are flagged as required fields
    mode: both

  - id: LEAD-001
    title: Leads list view loads
    mode: manual
    steps:
      - Open the Leads tab
      - Switch to the "All Open Leads" list view
    expected:
      - The list view loads without errors and shows the Name, Company and Lead Status columns
`;
