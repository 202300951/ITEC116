/**
 * Sanitizes HTML special characters in text inputs.
 */
function sanitizeInput(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Transforms a legacy healthcare database record into the target API JSON payload
 * based on the Section 2 Data Field Mapping & Transformation Matrix.
 */
function transformLegacyRecord(legacyRow) {
  // Rule: Concatenate (l_name + ", " + f_name)
  const fullName = `${legacyRow.l_name.trim()}, ${legacyRow.f_name.trim()}`;

  // Rule: Convert birthday & appointment_date to ISO 8601 date string (YYYY-MM-DD)
  const dateOfBirth =
    legacyRow.birthday instanceof Date
      ? legacyRow.birthday.toISOString().split("T")[0]
      : String(legacyRow.birthday).trim();

  const appointmentDate =
    legacyRow.appointment_date instanceof Date
      ? legacyRow.appointment_date.toISOString().split("T")[0]
      : String(legacyRow.appointment_date).trim();

  // Rule: Convert appointment_time to standard 24-hour time string (HH:MM:SS)
  const appointmentTime = String(legacyRow.appointment_time).trim();
  if (!/^\d{2}:\d{2}:\d{2}$/.test(appointmentTime)) {
    throw new Error(`Invalid 24-hour time format: ${appointmentTime}`);
  }

  // Rule: Validate contact length (VARCHAR(15))
  const contactNumber = String(legacyRow.contact).trim();
  if (contactNumber.length > 15) {
    throw new Error(`Contact number exceeds 15 characters: ${contactNumber}`);
  }

  // Rule: Standardize sex capitalization ("Male", "Female")
  const rawSex = String(legacyRow.sex).trim().toLowerCase();
  const sex = rawSex.charAt(0).toUpperCase() + rawSex.slice(1);
  if (sex !== "Male" && sex !== "Female") {
    throw new Error(`Invalid sex value: ${legacyRow.sex}`);
  }

  // Rule: Sanitize medical_history; return empty string if null
  const medicalHistory = sanitizeInput(legacyRow.medical_history);

  // Rule: Convert appointment_status INT(1) to Boolean (1 -> true, 0 -> false)
  const appointmentStatus = Boolean(Number(legacyRow.appointment_status));

  // Rule: Ensure valid foreign key mapping for assigned_doctor; handle null if unassigned
  const assignedDoctorId =
    legacyRow.assigned_doctor !== null && legacyRow.assigned_doctor !== undefined
      ? Number(legacyRow.assigned_doctor)
      : null;

  // Rule: Trim whitespace on doctor_name
  const doctorName = String(legacyRow.doctor_name).trim();

  return {
    patient: {
      patientId: Number(legacyRow.patient_no),
      fullName,
      dateOfBirth,
      contactNumber,
      sex,
      medicalHistory,
    },
    appointment: {
      appointmentId: Number(legacyRow.appointment_no),
      appointmentStatus,
      appointmentTime,
      appointmentDate,
      assignedDoctorId,
    },
    doctor: {
      doctorId: Number(legacyRow.doctor_no),
      doctorName,
    },
  };
}

/**
 * Sends the transformed JSON payload via HTTP POST (Task 3).
 */
async function sendToApi(payload) {
  const url = "https://jsonplaceholder.typicode.com/posts";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseData = await response.json();
  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log("Response Payload:", JSON.stringify(responseData, null, 2));
}

// Example execution using the sample record from the document
const sampleLegacyDbRow = {
  patient_no: 10025,
  f_name: "Omar Raouf",
  l_name: "Daud",
  birthday: "1997-02-26",
  contact: "+639289702892",
  sex: "male",
  medical_history: "Hypertension",
  appointment_no: 50001,
  appointment_status: 1,
  appointment_time: "10:00:00",
  appointment_date: "2026-08-25",
  assigned_doctor: "12",
  doctor_no: 12,
  doctor_name: "  Dr. Nathaniel Bakx  ",
};

const transformedPayload = transformLegacyRecord(sampleLegacyDbRow);
sendToApi(transformedPayload).catch(console.error);