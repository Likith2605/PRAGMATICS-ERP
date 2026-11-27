-- Purchase Requests are an independent procurement source, so a Vendor Enquiry
-- may link to a Purchase Request without also requiring a Purchase Indent.
ALTER TABLE vendor_enquiries
  ALTER COLUMN indent_number DROP NOT NULL;
