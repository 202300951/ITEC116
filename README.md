# ITEC 116 Laboratory Compilation

**System Integration and Architecture · BSIT 4-2 · Group 1 · 17 November 2026**

This compilation brings together the group’s eight laboratory activities. It follows the work from designing a healthcare integration to exchanging records between business systems, building a sales reporting pipeline, and documenting the defects found during testing.

## Contents

| Lab | Topic | What the folder contains |
| --- | --- | --- |
| 1 | Healthcare architecture | A design for connecting the appointment application to hospital records, including a system diagram, department access roles, and the technology selection matrix. [Architecture report](https://github.com/202300951/ITEC116/blob/master/LAB1/Group-1.C.pdf) |
| 2 | Healthcare data exchange | JSON and SOAP XML examples for a patient booking, with JavaScript that converts legacy patient, appointment, and doctor fields into the target format. [Payloads and transformation code](https://github.com/202300951/ITEC116/tree/master/LAB2) |
| 3 | Payroll and finance | A payroll-to-ledger simulation that balances debits and credits, checks for duplicate postings, and records the outcome in an audit log. [Payroll, journal, and audit files](https://github.com/202300951/ITEC116/tree/master/LAB3) |
| 4 | Sales and customer support | Event mappings for closed sales and escalated tickets, plus retry logic and a queue that preserves failed messages for reprocessing. [Mappings and delivery code](https://github.com/202300951/ITEC116/tree/master/LAB4) |
| 5 | Supply chain and project management | Middleware that turns a shipment delay into a project task update, including the hold status and schedule extension. [Integration code and sample records](https://github.com/202300951/ITEC116/tree/master/LAB5) |
| 6 | E-commerce and business intelligence | A storefront that stages orders and transforms their line items into sales records for a reporting dashboard. [Prototype documentation](https://github.com/202300951/ITEC116/blob/master/LAB6/README.md) |
| 7 | Alpha testing and fixes | Test cases, defects, and retest results for tax calculation, validation, duplicate orders, write retries, and recovery after a failed update. [Test report](https://github.com/202300951/ITEC116/blob/master/LAB7/cases.pdf) |
| 8 | Beta testing and bug fixing | The final report records seven business scenarios. Each entry identifies the action tested, the issue found, the correction, and the outcome. [Group 1 beta report](https://github.com/202300951/ITEC116/blob/master/LAB8/Group1_Lab8.pdf) |

## Code and repository organization

Each lab keeps its source code, sample records, or reports in its own numbered folder. In Lab 7, the HTTP server delegates validation, storage, data transformation, and reporting to separate modules. Function comments explain details such as when a failed write is retried and how the last saved reporting data is restored. During transformation, maps reuse customer, product, and date entries across sales records. [Lab 7 source modules](https://github.com/202300951/ITEC116/tree/master/LAB7/src)

The Lab 7 package manifest and lockfile record the application version and Node.js requirement. Its configuration accepts the ingestion token through the environment. The Git snapshot identifies the exact set of lab files covered by this compilation. [Package metadata](https://github.com/202300951/ITEC116/blob/master/LAB7/package.json) · [Compilation snapshot](https://github.com/202300951/ITEC116/tree/f2fee3653c54b071fda848857debd8f0d588fb18)

## Group members

Allen James Nico Acosta, Nathaniel Cornelis Jerardo Bakx, Omar Raouf Daud, Mark Joshua Delos Santos, Jesmon Javier, Lenerd Mcgowan, Yoshikazu Nagahama, Jherecho Pilorin, Jommel Sean Quilon, and Geoffrey Soriano.
